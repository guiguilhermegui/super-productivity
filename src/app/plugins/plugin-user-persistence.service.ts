import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import {
  PluginUserData,
  MAX_PLUGIN_DATA_SIZE,
  MIN_PLUGIN_PERSIST_INTERVAL_MS,
} from './plugin-persistence.model';
import { upsertPluginUserData, deletePluginUserData } from './store/plugin.actions';
import { selectPluginUserDataFeatureState } from './store/plugin-user-data.reducer';

/**
 * Service for persisting plugin user data using NgRx actions.
 * Handles data that plugins store and retrieve via persistDataSynced/loadSyncedData.
 * Includes rate limiting and size validation to prevent abuse.
 */
@Injectable({
  providedIn: 'root',
})
export class PluginUserPersistenceService {
  private _store = inject(Store);

  /**
   * Track the last *committed* persist time per plugin, for rate limiting.
   */
  private _lastPersistTime = new Map<string, number>();

  /**
   * Data that arrived inside the rate-limit window and is waiting to be
   * committed. Coalesced — only the most recent value per plugin is kept.
   */
  private _pendingData = new Map<string, string>();

  /**
   * Active flush timers for coalesced writes, keyed by plugin id.
   */
  private _flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Persist user data for a specific plugin (called by plugin via persistDataSynced).
   *
   * Rate limiting *coalesces* rather than rejects: a call that arrives inside
   * the MIN_PLUGIN_PERSIST_INTERVAL_MS window is not dropped — its data is
   * held and committed when the window opens (latest write wins). This still
   * caps the op-log/sync rate at one write per interval, but never discards
   * the caller's most recent data. Dropping it silently lost edits — e.g. a
   * plugin's final save on teardown landing just after a periodic save.
   *
   * @throws Error if data exceeds MAX_PLUGIN_DATA_SIZE
   */
  persistPluginUserData(pluginId: string, data: string): void {
    // Validate data size — applies whether the write commits now or later.
    const dataSize = new Blob([data]).size;
    if (dataSize > MAX_PLUGIN_DATA_SIZE) {
      throw new Error(
        `Plugin data exceeds maximum size of ${MAX_PLUGIN_DATA_SIZE / 1024}KB. ` +
          `Current size: ${Math.round(dataSize / 1024)}KB`,
      );
    }

    // Rate limiting: check if enough time has passed since the last commit.
    const now = Date.now();
    const lastPersist = this._lastPersistTime.get(pluginId) || 0;
    const timeSinceLastPersist = now - lastPersist;

    if (timeSinceLastPersist < MIN_PLUGIN_PERSIST_INTERVAL_MS) {
      // Inside the window: coalesce. Hold the latest data and flush it once
      // the window opens, so no write is discarded.
      this._pendingData.set(pluginId, data);
      if (!this._flushTimers.has(pluginId)) {
        const delay = MIN_PLUGIN_PERSIST_INTERVAL_MS - timeSinceLastPersist;
        this._flushTimers.set(
          pluginId,
          setTimeout(() => this._flushPendingData(pluginId), delay),
        );
      }
      return;
    }

    this._commit(pluginId, data, now);
  }

  /**
   * Commit a coalesced write once its rate-limit window has elapsed.
   */
  private _flushPendingData(pluginId: string): void {
    this._flushTimers.delete(pluginId);
    const data = this._pendingData.get(pluginId);
    if (data === undefined) {
      return;
    }
    this._pendingData.delete(pluginId);
    this._commit(pluginId, data, Date.now());
  }

  /**
   * Dispatch the persist action and record the commit time for rate limiting.
   */
  private _commit(pluginId: string, data: string, at: number): void {
    this._lastPersistTime.set(pluginId, at);
    const pluginUserData: PluginUserData = {
      id: pluginId,
      data,
    };
    this._store.dispatch(upsertPluginUserData({ pluginUserData }));
  }

  /**
   * Load user data for a specific plugin (called by plugin via loadSyncedData).
   *
   * Returns a coalesced-but-not-yet-committed write if one is pending, so a
   * plugin's read-modify-write cycle always sees its own latest data.
   */
  async loadPluginUserData(pluginId: string): Promise<string | null> {
    const pending = this._pendingData.get(pluginId);
    if (pending !== undefined) {
      return pending;
    }
    const currentState = await firstValueFrom(
      this._store.select(selectPluginUserDataFeatureState),
    );
    const pluginData = currentState.find((item) => item.id === pluginId);
    return pluginData?.data || null;
  }

  /**
   * Remove user data for a specific plugin.
   */
  removePluginUserData(pluginId: string): void {
    this._cancelPending(pluginId);
    this._store.dispatch(deletePluginUserData({ pluginId }));
  }

  /**
   * Drop any pending coalesced write (and its timer) for a plugin, so it
   * cannot resurrect data that is being removed.
   */
  private _cancelPending(pluginId: string): void {
    const timer = this._flushTimers.get(pluginId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._flushTimers.delete(pluginId);
    }
    this._pendingData.delete(pluginId);
  }

  /**
   * Get all plugin user data
   */
  async getAllPluginUserData(): Promise<PluginUserData[]> {
    return firstValueFrom(this._store.select(selectPluginUserDataFeatureState));
  }

  /**
   * Clear all plugin user data (removes each one individually to create operations)
   */
  async clearAllPluginUserData(): Promise<void> {
    const currentState = await firstValueFrom(
      this._store.select(selectPluginUserDataFeatureState),
    );
    for (const item of currentState) {
      this._cancelPending(item.id);
      this._store.dispatch(deletePluginUserData({ pluginId: item.id }));
    }
  }
}
