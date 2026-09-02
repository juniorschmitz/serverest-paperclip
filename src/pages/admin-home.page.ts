import type { Locator, Page } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * /admin/home — where an administrador lands after login.
 *
 * The "cadastrar produtos" tile carries a misspelled testid in the shipped
 * bundle: `cadastarProdutos` (no first "r") sits alongside the correctly spelled
 * `cadastrarProdutos` elsewhere in the app. Matching both means the suite keeps
 * working whether or not that typo is ever fixed — a fix would otherwise break
 * every test that touches this tile, for no behavioural reason.
 */
export class AdminHomePage extends BasePage {
  readonly path = '/admin/home';

  readonly cadastrarUsuarios: Locator;
  readonly listarUsuarios: Locator;
  readonly cadastrarProdutos: Locator;
  readonly listarProdutos: Locator;
  readonly relatorios: Locator;
  readonly logout: Locator;

  constructor(page: Page) {
    super(page);
    this.cadastrarUsuarios = page.getByTestId('cadastrarUsuarios');
    this.listarUsuarios = page.getByTestId('listarUsuarios');
    this.cadastrarProdutos = page
      .getByTestId('cadastarProdutos')
      .or(page.getByTestId('cadastrarProdutos'))
      .first();
    this.listarProdutos = page.getByTestId('listarProdutos');
    this.relatorios = page.getByTestId('relatorios');
    this.logout = page.getByTestId('logout');
  }

  /** The greeting carries the logged-in user's name; used to prove who we are. */
  welcomeText(): Locator {
    return this.page.getByRole('heading').first();
  }
}
