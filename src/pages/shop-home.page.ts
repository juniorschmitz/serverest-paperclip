import type { Locator, Page } from '@playwright/test';
import { BasePage } from './base.page';

/** /home — the storefront a non-admin sees. */
export class ShopHomePage extends BasePage {
  readonly path = '/home';

  readonly searchInput: Locator;
  readonly searchButton: Locator;
  readonly productList: Locator;
  readonly cartButton: Locator;
  readonly myListButton: Locator;
  readonly logout: Locator;

  constructor(page: Page) {
    super(page);
    this.searchInput = page.getByTestId('pesquisar');
    this.searchButton = page.getByTestId('botaoPesquisar');
    this.productList = page.getByTestId('listaProdutos');
    this.cartButton = page.getByTestId('shopping-cart-button');
    this.myListButton = page.getByTestId('adicionarNaLista');
    this.logout = page.getByTestId('logout');
  }

  /**
   * A single product row, scoped by its visible name.
   *
   * Scoping by name rather than by index is the difference between a test that
   * survives someone else adding a product to the shared instance and one that
   * does not. Never address a list row positionally here.
   */
  productCard(name: string): Locator {
    return this.productList.locator('.card', { hasText: name });
  }

  async search(term: string): Promise<void> {
    await this.searchInput.fill(term);
    await this.searchButton.click();
  }
}
