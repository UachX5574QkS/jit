import { Component } from '@angular/core';

/**
 * Centred footer for the ui-foundations shell: brand name in purple, a privacy
 * link, and copyright plus system status in muted 12px text.
 */
@Component({
  selector: 'app-footer',
  imports: [],
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
})
export class Footer {
  protected readonly year = new Date().getFullYear();
}
