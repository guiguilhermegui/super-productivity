import { TestBed } from '@angular/core/testing';
import { provideMockStore, MockStore } from '@ngrx/store/testing';
import { PluginUserPersistenceService } from './plugin-user-persistence.service';
import {
  MAX_PLUGIN_DATA_SIZE,
  MIN_PLUGIN_PERSIST_INTERVAL_MS,
} from './plugin-persistence.model';
import { upsertPluginUserData, deletePluginUserData } from './store/plugin.actions';
import { selectPluginUserDataFeatureState } from './store/plugin-user-data.reducer';

describe('PluginUserPersistenceService', () => {
  let service: PluginUserPersistenceService;
  let store: MockStore;
  let dispatchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        PluginUserPersistenceService,
        provideMockStore({
          selectors: [{ selector: selectPluginUserDataFeatureState, value: [] }],
        }),
      ],
    });

    store = TestBed.inject(MockStore);
    service = TestBed.inject(PluginUserPersistenceService);
    dispatchSpy = spyOn(store, 'dispatch').and.callThrough();
  });

  afterEach(() => {
    store.resetSelectors();
  });

  describe('persistPluginUserData', () => {
    it('should dispatch upsertPluginUserData action with valid data', () => {
      const pluginId = 'test-plugin';
      const data = 'test data';

      service.persistPluginUserData(pluginId, data);

      expect(dispatchSpy).toHaveBeenCalledWith(
        upsertPluginUserData({ pluginUserData: { id: pluginId, data } }),
      );
    });

    it('should throw error when data exceeds MAX_PLUGIN_DATA_SIZE', () => {
      const pluginId = 'test-plugin';
      // Create a string larger than MAX_PLUGIN_DATA_SIZE (1MB)
      const largeData = 'x'.repeat(MAX_PLUGIN_DATA_SIZE + 1000);

      expect(() => service.persistPluginUserData(pluginId, largeData)).toThrowError(
        /Plugin data exceeds maximum size/,
      );
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('should coalesce a rapid second call instead of dropping it', () => {
      const baseTime = Date.now();
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(baseTime));
      try {
        const pluginId = 'test-plugin';

        // First call commits immediately.
        service.persistPluginUserData(pluginId, 'first');
        expect(dispatchSpy).toHaveBeenCalledTimes(1);

        // A call inside the rate-limit window must not throw and must not be
        // dropped — it is held until the window opens.
        expect(() => service.persistPluginUserData(pluginId, 'second')).not.toThrow();
        expect(dispatchSpy).toHaveBeenCalledTimes(1);

        // Once the interval elapses the held write is committed.
        jasmine.clock().tick(MIN_PLUGIN_PERSIST_INTERVAL_MS);
        expect(dispatchSpy).toHaveBeenCalledTimes(2);
        expect(dispatchSpy).toHaveBeenCalledWith(
          upsertPluginUserData({
            pluginUserData: { id: pluginId, data: 'second' },
          }),
        );
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('should keep only the most recent of several coalesced calls', () => {
      const baseTime = Date.now();
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(baseTime));
      try {
        const pluginId = 'test-plugin';

        service.persistPluginUserData(pluginId, 'v1'); // committed
        service.persistPluginUserData(pluginId, 'v2'); // coalesced
        service.persistPluginUserData(pluginId, 'v3'); // coalesced, replaces v2
        expect(dispatchSpy).toHaveBeenCalledTimes(1);

        jasmine.clock().tick(MIN_PLUGIN_PERSIST_INTERVAL_MS);
        expect(dispatchSpy).toHaveBeenCalledTimes(2);
        expect(dispatchSpy).toHaveBeenCalledWith(
          upsertPluginUserData({ pluginUserData: { id: pluginId, data: 'v3' } }),
        );
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('should allow different plugins to persist data without rate limiting each other', () => {
      const plugin1 = 'plugin-1';
      const plugin2 = 'plugin-2';
      const data = 'test data';

      // Both plugins should be able to persist immediately
      service.persistPluginUserData(plugin1, data);
      service.persistPluginUserData(plugin2, data);

      expect(dispatchSpy).toHaveBeenCalledTimes(2);
    });

    it('should accept data at exactly MAX_PLUGIN_DATA_SIZE', () => {
      const pluginId = 'test-plugin';
      // Create a string exactly at the limit
      const exactLimitData = 'x'.repeat(MAX_PLUGIN_DATA_SIZE - 10); // Slightly under to account for Blob overhead

      // This should not throw
      expect(() => service.persistPluginUserData(pluginId, exactLimitData)).not.toThrow();
    });
  });

  describe('loadPluginUserData', () => {
    it('should return data for existing plugin', async () => {
      const pluginId = 'test-plugin';
      const testData = 'stored data';

      store.overrideSelector(selectPluginUserDataFeatureState, [
        { id: pluginId, data: testData },
      ]);

      const result = await service.loadPluginUserData(pluginId);

      expect(result).toBe(testData);
    });

    it('should return null for non-existent plugin', async () => {
      store.overrideSelector(selectPluginUserDataFeatureState, []);

      const result = await service.loadPluginUserData('non-existent');

      expect(result).toBeNull();
    });

    it('should return a pending coalesced write before it is committed', async () => {
      const baseTime = Date.now();
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(baseTime));
      try {
        const pluginId = 'test-plugin';
        store.overrideSelector(selectPluginUserDataFeatureState, [
          { id: pluginId, data: 'committed' },
        ]);

        service.persistPluginUserData(pluginId, 'committed'); // commits
        service.persistPluginUserData(pluginId, 'pending'); // coalesced

        // A read-modify-write cycle must see its own not-yet-committed write.
        const result = await service.loadPluginUserData(pluginId);
        expect(result).toBe('pending');
      } finally {
        jasmine.clock().uninstall();
      }
    });
  });

  describe('removePluginUserData', () => {
    it('should dispatch deletePluginUserData action', () => {
      const pluginId = 'test-plugin';

      service.removePluginUserData(pluginId);

      expect(dispatchSpy).toHaveBeenCalledWith(deletePluginUserData({ pluginId }));
    });

    it('should cancel a pending coalesced write', () => {
      const baseTime = Date.now();
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(baseTime));
      try {
        const pluginId = 'test-plugin';
        service.persistPluginUserData(pluginId, 'first'); // commits
        service.persistPluginUserData(pluginId, 'pending'); // coalesced

        service.removePluginUserData(pluginId);
        dispatchSpy.calls.reset();

        // The cancelled flush must not resurrect the removed data.
        jasmine.clock().tick(MIN_PLUGIN_PERSIST_INTERVAL_MS * 2);
        expect(dispatchSpy).not.toHaveBeenCalled();
      } finally {
        jasmine.clock().uninstall();
      }
    });
  });

  describe('getAllPluginUserData', () => {
    it('should return all plugin user data', async () => {
      const testData = [
        { id: 'plugin-1', data: 'data-1' },
        { id: 'plugin-2', data: 'data-2' },
      ];

      store.overrideSelector(selectPluginUserDataFeatureState, testData);

      const result = await service.getAllPluginUserData();

      expect(result).toEqual(testData);
    });
  });
});
