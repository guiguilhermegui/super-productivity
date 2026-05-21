import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { PluginBridgeService } from '../plugin-bridge.service';
import { PluginWorkContextHeaderBtnCfg } from '../plugin-api.model';

@Component({
  selector: 'plugin-work-context-header-btns',
  template: `
    @for (button of buttons(); track button.pluginId + button.label) {
      <button
        mat-icon-button
        [matTooltip]="button.label"
        (click)="onClick(button)"
      >
        <mat-icon>{{ button.icon }}</mat-icon>
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconButton, MatIcon, MatTooltip],
})
export class PluginWorkContextHeaderBtnsComponent {
  private readonly _pluginBridge = inject(PluginBridgeService);

  readonly buttons = this._pluginBridge.workContextHeaderButtons;

  async onClick(button: PluginWorkContextHeaderBtnCfg): Promise<void> {
    const ctx = await this._pluginBridge.getActiveWorkContext();
    if (ctx) {
      button.onClick(ctx);
    }
  }
}
