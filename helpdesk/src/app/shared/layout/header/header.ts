import { Component, inject } from '@angular/core';
import { ThemeService } from '../../../core/theme/theme.service';
import { TextSizeService, type TextSize } from '../../../core/text-size/text-size.service';

/**
 * Top header bar for the ui-foundations shell.
 *
 * A right-aligned flex row: search → dark-mode toggle → chat → notifications →
 * profile. Its min-height matches the sidebar header so the horizontal border
 * lines line up.
 */
@Component({
  selector: 'app-header',
  imports: [],
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class Header {
  protected readonly theme = inject(ThemeService);
  protected readonly textSize = inject(TextSizeService);

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  /** Apply the text size chosen from the header drop-down (accessibility). */
  protected onTextSizeChange(value: string): void {
    this.textSize.setSize(value as TextSize);
  }
}
