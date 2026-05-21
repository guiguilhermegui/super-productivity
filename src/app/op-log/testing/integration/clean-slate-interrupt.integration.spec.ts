import { TestBed } from '@angular/core/testing';
import { OperationLogStoreService } from '../../persistence/operation-log-store.service';
import { CleanSlateService } from '../../clean-slate/clean-slate.service';
import { StateSnapshotService } from '../../backup/state-snapshot.service';
import { ClientIdService } from '../../../core/util/client-id.service';
import { PreMigrationBackupService } from '../../clean-slate/pre-migration-backup.service';
import { SyncLocalStateService } from '../../sync/sync-local-state.service';
import { TranslateService } from '@ngx-translate/core';
import { CURRENT_SCHEMA_VERSION } from '../../persistence/schema-migration.service';

/**
 * Integration tests for issue #7709 — `createCleanSlate` interrupted mid-sequence.
 *
 * The reported bug requires that on a surviving device, `isWhollyFreshClient()`
 * returns true (i.e. `state_cache===null && lastSeq===0`) while NgRx in-memory
 * state still has meaningful data. This file proves that an interrupt between
 * `clearAllOperations()` and `saveStateCache(...)` produces exactly that
 * post-condition on a low-activity device (no prior `state_cache`).
 *
 * Tests use real IndexedDB; the destructive sequence is interrupted by
 * making the next op-log call throw.
 */
describe('CleanSlate interrupt (issue #7709 precondition)', () => {
  let storeService: OperationLogStoreService;
  let syncLocalState: SyncLocalStateService;
  let cleanSlate: CleanSlateService;
  let mockStateSnapshot: jasmine.SpyObj<StateSnapshotService>;
  let mockClientId: jasmine.SpyObj<ClientIdService>;
  let mockPreMigration: jasmine.SpyObj<PreMigrationBackupService>;
  let mockTranslate: jasmine.SpyObj<TranslateService>;

  const meaningfulState = {
    task: {
      ids: ['t1', 't2', 't3'],
      entities: { t1: { id: 't1' }, t2: { id: 't2' }, t3: { id: 't3' } },
    },
    project: { ids: ['INBOX'], entities: {} },
    tag: { ids: [], entities: {} },
    note: { ids: [], entities: {} },
    globalConfig: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  beforeEach(async () => {
    mockStateSnapshot = jasmine.createSpyObj('StateSnapshotService', [
      'getStateSnapshot',
      'getStateSnapshotAsync',
    ]);
    mockStateSnapshot.getStateSnapshot.and.returnValue(meaningfulState as any);
    mockStateSnapshot.getStateSnapshotAsync.and.resolveTo(meaningfulState as any);

    mockClientId = jasmine.createSpyObj('ClientIdService', ['generateNewClientId']);
    mockClientId.generateNewClientId.and.resolveTo('cNew1');

    mockPreMigration = jasmine.createSpyObj('PreMigrationBackupService', [
      'createPreMigrationBackup',
    ]);
    mockPreMigration.createPreMigrationBackup.and.resolveTo();

    mockTranslate = jasmine.createSpyObj('TranslateService', ['instant']);
    mockTranslate.instant.and.callFake((k: string) => k);

    TestBed.configureTestingModule({
      providers: [
        OperationLogStoreService,
        SyncLocalStateService,
        CleanSlateService,
        { provide: StateSnapshotService, useValue: mockStateSnapshot },
        { provide: ClientIdService, useValue: mockClientId },
        { provide: PreMigrationBackupService, useValue: mockPreMigration },
        { provide: TranslateService, useValue: mockTranslate },
      ],
    });

    storeService = TestBed.inject(OperationLogStoreService);
    syncLocalState = TestBed.inject(SyncLocalStateService);
    cleanSlate = TestBed.inject(CleanSlateService);

    await storeService.init();
    await storeService._clearAllDataForTesting();
  });

  describe('baseline (no interrupt)', () => {
    it('completes the destructive sequence and leaves a populated state_cache', async () => {
      // Precondition: nothing exists yet.
      expect(await syncLocalState.isWhollyFreshClient()).toBe(true);

      await cleanSlate.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      // Post: SYNC_IMPORT op stored AND state_cache populated.
      expect(await storeService.getLastSeq()).toBeGreaterThan(0);
      const cache = await storeService.loadStateCache();
      expect(cache).not.toBeNull();
      expect(cache!.state).toEqual(meaningfulState as any);
      expect(await syncLocalState.isWhollyFreshClient()).toBe(false);
    });
  });

  describe('interrupt between clearAllOperations() and append() — the reported chain', () => {
    it('leaves OPS empty AND state_cache null when device had never compacted', async () => {
      // Low-activity device: ops exist but never reached COMPACTION_THRESHOLD = 500,
      // so state_cache was never written. Seed 3 user ops directly via append.
      const userOps = Array.from({ length: 3 }, (_, i) => ({
        id: `op-${i}`,
        actionType: 'TASK_ADD' as any,
        opType: 'Create' as any,
        entityType: 'TASK' as any,
        entityId: `t${i}`,
        payload: { id: `t${i}` },
        clientId: 'cPrior',
        vectorClock: { cPrior: i + 1 },
        timestamp: Date.now() + i,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      }));
      for (const op of userOps) {
        await storeService.append(op as any, 'local');
      }
      // State at this point: lastSeq > 0, state_cache===null (never compacted).
      // We don't assert exact seq because IDB autoincrement persists across the
      // beforeEach _clearAllDataForTesting (clear() does not reset the key generator).
      const seqBefore = await storeService.getLastSeq();
      expect(seqBefore).toBeGreaterThan(0);
      expect(await storeService.loadStateCache()).toBeNull();
      expect(await syncLocalState.isWhollyFreshClient()).toBe(false);

      // Inject the interrupt: clearAllOperations succeeds, then append throws.
      // This is the window between clean-slate.service.ts:151 and :154.
      const realAppend = storeService.append.bind(storeService);
      let appendCalls = 0;
      spyOn(storeService, 'append').and.callFake(async () => {
        appendCalls++;
        // The first append after clearAllOperations() is the SYNC_IMPORT op.
        // Throw to simulate a crash/tab-close at exactly that moment.
        throw new Error('Simulated interrupt: tab closed mid-clean-slate');
      });

      await expectAsync(
        cleanSlate.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED'),
      ).toBeRejected();

      expect(appendCalls).toBe(1);

      // POST-CONDITION: this is the precondition for issue #7709's chain.
      // The device now reads as a fresh client even though NgRx (mocked above)
      // still has meaningful state.
      expect(await storeService.getLastSeq()).toBe(0); // ops were cleared, SYNC_IMPORT never landed
      expect(await storeService.loadStateCache()).toBeNull(); // never reached step 4
      expect(await syncLocalState.isWhollyFreshClient()).toBe(true);
      // And meaningful store data is still there (from the mock):
      expect(syncLocalState.hasMeaningfulStoreData()).toBe(true);

      // This combination is what `operation-log-sync.service.ts:599-606`
      // detects as the conflict-throw branch. The interrupt at append() is
      // sufficient to reach `isWhollyFreshClient + hasMeaningfulStoreData`.

      // Restore the spy for any later test sharing module state.
      (storeService.append as any).and.callFake(realAppend);
    });
  });

  describe('interrupt between append() and saveStateCache()', () => {
    it('leaves lastSeq>0 BUT state_cache still null — not the #7709 chain, but still corrupt', async () => {
      // Same precondition: never compacted, so state_cache===null.
      // No prior ops this time — start clean.
      expect(await storeService.loadStateCache()).toBeNull();

      // Interrupt: clear and append succeed, setVectorClock throws.
      spyOn(storeService, 'setVectorClock').and.callFake(async () => {
        throw new Error('Simulated interrupt: tab closed before vector-clock write');
      });

      await expectAsync(
        cleanSlate.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED'),
      ).toBeRejected();

      // POST: SYNC_IMPORT op landed (lastSeq>0), but state_cache still null
      // because setVectorClock errored before saveStateCache (line 162) ran.
      expect(await storeService.getLastSeq()).toBeGreaterThan(0);
      expect(await storeService.loadStateCache()).toBeNull();

      // isWhollyFreshClient is FALSE here because lastSeq>0. So this interrupt
      // pattern does NOT route through the #7709 conflict dialog — but the
      // device's state_cache is still missing, which is a related corruption.
      expect(await syncLocalState.isWhollyFreshClient()).toBe(false);
    });
  });

  describe('on a device that HAD previously compacted (state_cache exists)', () => {
    it('preserves state_cache when interrupted at append()', async () => {
      // Simulate a prior compaction: state_cache is populated.
      await storeService.saveStateCache({
        state: { sentinel: 'prior-state' } as any,
        lastAppliedOpSeq: 0,
        vectorClock: { cPrior: 5 },
        compactedAt: Date.now(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(await storeService.loadStateCache()).not.toBeNull();
      expect(await syncLocalState.isWhollyFreshClient()).toBe(false);

      // Inject interrupt at append.
      spyOn(storeService, 'append').and.callFake(async () => {
        throw new Error('Simulated interrupt');
      });

      await expectAsync(
        cleanSlate.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED'),
      ).toBeRejected();

      // Post: OPS was cleared, but the prior state_cache is STILL there
      // (createCleanSlate never re-saved it). So isWhollyFreshClient is FALSE.
      // → A previously-compacted device is NOT vulnerable to the #7709 chain
      //   via this interrupt path, because state_cache survives.
      expect(await storeService.getLastSeq()).toBe(0);
      const cache = await storeService.loadStateCache();
      expect(cache).not.toBeNull();
      expect((cache!.state as any).sentinel).toBe('prior-state');
      expect(await syncLocalState.isWhollyFreshClient()).toBe(false);
    });
  });
});
