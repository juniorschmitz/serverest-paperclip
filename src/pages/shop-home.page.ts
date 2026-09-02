import type { Locator, Page } from '@playwright/test';
import { BasePage } from './base.page';

/** /home — the storefront a non-admin sees. */
export class ShopHomePage extends BasePage {
  readonly path = '/home';

  readonly searchInput: Locator;
  readonly searchButton: Locator;
  readonly cartButton: Locator;
  readonly myListButton: Locator;
  readonly logout: Locator;

  constructor(page: Page) {
    super(page);
    this.searchInput = page.getByTestId('pesquisar');
    this.searchButton = page.getByTestId('botaoPesquisar');
    this.cartButton = page.getByTestId('shopping-cart-button');
    this.myListButton = page.getByTestId('adicionarNaLista');
    this.logout = page.getByTestId('logout');
  }

  /**
   * A single product row, scoped by its visible name.
   *
   * There is no test id for the product grid or for an individual card's name
   * on this page. `data-testid="listaProdutos"` — documented as a Storefront
   * id in docs/selector-strategy.md — is actually bound to the cart-size
   * badge `<span>` in the nav bar (same element the app also exposes as
   * `shopping-cart-button`'s sibling), verified against the live DOM on
   * 2026-09-02, not to any product list. There is nothing to scope into, so
   * `.card` (selector-strategy.md tier 4) is queried directly from the page,
   * by content rather than position — a shared-sandbox product someone else
   * adds never shifts which row this addresses.
   */
  productCard(name: string): Locator {
    return this.page.locator('.card', { hasText: name });
  }

  async search(term: string): Promise<void> {
    await this.searchInput.fill(term);
    await this.searchButton.click();
  }
}
