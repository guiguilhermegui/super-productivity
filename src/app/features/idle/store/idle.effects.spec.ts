import { TestBed } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { Action } from '@ngrx/store';
import { EMPTY, Subject } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';

import { IdleEffects } from './idle.effects';
import { idleDialogResult } from './idle.actions';
import { LOCAL_ACTIONS } from '../../../util/local-actions.token';
import { TaskService } from '../../tasks/task.service';
import { WorkContextService } from '../../work-context/work-context.service';
import { SimpleCounterService } from '../../simple-counter/simple-counter.service';
import { UiHelperService } from '../../ui-helper/ui-helper.service';
import { ChromeExtensionInterfaceService } from '../../../core/chrome-extension-interface/chrome-extension-interface.service';
import { DateService } from '../../../core/date/date.service';
import { DataInitStateService } from '../../../core/data-init/data-init-state.service';
import { DEFAULT_TASK, Task } from '../../tasks/task.model';
import { IdleTrackItem } from '../dialog-idle/dialog-idle.model';

const H = 60 * 60 * 1000;

describe('IdleEffects handleIdleDialogResult$ (cross-midnight, #3888)', () => {
  let effects: IdleEffects;
  let actions$: Subject<Action>;
  let taskService: jasmine.SpyObj<TaskService>;

  const buildTask = (id: string): Task => ({ ...DEFAULT_TASK, id }) as Task;

  const dispatchIdleResult = (trackItems: IdleTrackItem[], idleTime: number): void => {
    actions$.next(
      idleDialogResult({
        idleTime,
        isResetBreakTimer: false,
        wasFocusSessionRunning: false,
        trackItems,
      }),
    );
  };

  beforeEach(() => {
    jasmine.clock().install();
    actions$ = new Subject<Action>();

    taskService = jasmine.createSpyObj('TaskService', [
      'add',
      'addTimeSpentForDays',
      'addTimeSpentAndSync',
      'setCurrentId',
      'currentTaskId',
      'removeTimeSpent',
    ]);
    taskService.add.and.returnValue('new-task-id');

    TestBed.configureTestingModule({
      providers: [
        IdleEffects,
        provideMockStore(),
        { provide: LOCAL_ACTIONS, useValue: actions$ },
        { provide: TaskService, useValue: taskService },
        {
          provide: WorkContextService,
          useValue: jasmine.createSpyObj('WorkContextService', [
            'addToBreakTimeForActiveContext',
          ]),
        },
        {
          provide: SimpleCounterService,
          useValue: jasmine.createSpyObj(
            'SimpleCounterService',
            ['increaseCounterToday', 'toggleCounter', 'decreaseCounterToday'],
            { enabledSimpleStopWatchCounters$: EMPTY },
          ),
        },
        {
          provide: UiHelperService,
          useValue: jasmine.createSpyObj('UiHelperService', [
            'focusAppAfterNotification',
          ]),
        },
        {
          provide: ChromeExtensionInterfaceService,
          useValue: jasmine.createSpyObj(
            'ChromeExtensionInterfaceService',
            ['addEventListener'],
            { onReady$: EMPTY },
          ),
        },
        {
          provide: DateService,
          useValue: jasmine.createSpyObj(
            'DateService',
            ['getStartOfNextDayDiffMs', 'todayStr'],
            // no start-of-next-day offset
            {},
          ),
        },
        { provide: DataInitStateService, useValue: { isAllDataLoadedInitially$: EMPTY } },
        { provide: MatDialog, useValue: jasmine.createSpyObj('MatDialog', ['open']) },
      ],
    });

    (TestBed.inject(DateService).getStartOfNextDayDiffMs as jasmine.Spy).and.returnValue(
      0,
    );
    effects = TestBed.inject(IdleEffects);
    effects.handleIdleDialogResult$.subscribe();
  });

  afterEach(() => {
    jasmine.clock().uninstall();
    TestBed.inject(MockStore).resetSelectors();
  });

  it('splits idle time across two days for an existing task', () => {
    // Returned at 02:00 local, 4h of idle => 22:00 prev day -> 02:00 this day.
    jasmine.clock().mockDate(new Date(2026, 5, 1, 2, 0, 0));
    const task = buildTask('existing-1');

    dispatchIdleResult(
      [{ type: 'TASK', time: 'IDLE_TIME', simpleCounterToggleBtns: [], task }],
      4 * H,
    );

    expect(taskService.addTimeSpentForDays).toHaveBeenCalledTimes(1);
    const [taskArg, mapArg] = taskService.addTimeSpentForDays.calls.mostRecent().args;
    expect(taskArg.id).toBe('existing-1');
    const expected: { [d: string]: number } = {};
    expected['2026-05-31'] = 2 * H;
    expected['2026-06-01'] = 2 * H;
    expect(mapArg).toEqual(expected);
    expect(taskService.setCurrentId).toHaveBeenCalledWith('existing-1');
  });

  it('keeps a same-day idle interval on one day for an existing task', () => {
    jasmine.clock().mockDate(new Date(2026, 5, 1, 16, 0, 0));
    const task = buildTask('existing-1');

    dispatchIdleResult(
      [{ type: 'TASK', time: 'IDLE_TIME', simpleCounterToggleBtns: [], task }],
      2 * H,
    );

    const [, mapArg] = taskService.addTimeSpentForDays.calls.mostRecent().args;
    const expected: { [d: string]: number } = {};
    expected['2026-06-01'] = 2 * H;
    expect(mapArg).toEqual(expected);
  });

  it('creates a new task with a cross-midnight split timeSpentOnDay map', () => {
    jasmine.clock().mockDate(new Date(2026, 5, 1, 2, 0, 0));

    dispatchIdleResult(
      [
        {
          type: 'TASK',
          time: 'IDLE_TIME',
          simpleCounterToggleBtns: [],
          title: 'Late work',
        },
      ],
      4 * H,
    );

    expect(taskService.add).toHaveBeenCalledTimes(1);
    const [title, isAddToBacklog, additionalFields] = taskService.add.calls.mostRecent()
      .args as [string, boolean, Partial<Task>];
    expect(title).toBe('Late work');
    expect(isAddToBacklog).toBe(false);
    expect(additionalFields.timeSpent).toBe(4 * H);
    const expected: { [d: string]: number } = {};
    expected['2026-05-31'] = 2 * H;
    expected['2026-06-01'] = 2 * H;
    expect(additionalFields.timeSpentOnDay).toEqual(expected);
    expect(taskService.setCurrentId).toHaveBeenCalledWith('new-task-id');
  });

  it('honors the start-of-next-day offset when splitting (existing task)', () => {
    // 4h offset => logical day starts at 04:00. Returned at 06:00 with 4h idle
    // (02:00 -> 06:00): 02:00-04:00 is the previous logical day, 04:00-06:00 today.
    (TestBed.inject(DateService).getStartOfNextDayDiffMs as jasmine.Spy).and.returnValue(
      4 * H,
    );
    jasmine.clock().mockDate(new Date(2026, 5, 1, 6, 0, 0));
    const task = buildTask('existing-1');

    dispatchIdleResult(
      [{ type: 'TASK', time: 'IDLE_TIME', simpleCounterToggleBtns: [], task }],
      4 * H,
    );

    const [, mapArg] = taskService.addTimeSpentForDays.calls.mostRecent().args;
    const expected: { [d: string]: number } = {};
    expected['2026-05-31'] = 2 * H;
    expected['2026-06-01'] = 2 * H;
    expect(mapArg).toEqual(expected);
  });
});
