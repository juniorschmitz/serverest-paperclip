import type { Locator, Page } from '@playwright/test';
import type { UserPayload } from '@/data/factories';
import { BasePage } from './base.page';

/** /cadastrarusuarios — the public sign-up form. */
export class RegisterPage extends BasePage {
  readonly path = '/cadastrarusuarios';

  readonly nome: Locator;
  readonly email: Locator;
  readonly password: Locator;
  /** "Cadastrar como administrador" — the app's testid for it is just "checkbox". */
  readonly administradorCheckbox: Locator;
  readonly submit: Locator;
  /** Validation banner the form renders on a rejected submit. */
  readonly alert: Locator;

  constructor(page: Page) {
    super(page);
    this.nome = page.getByTestId('nome');
    this.email = page.getByTestId('email');
    this.password = page.getByTestId('password');
    this.administradorCheckbox = page.getByTestId('checkbox');
    this.submit = page.getByTestId('cadastrar');
    // No testid on the alert; role is the next-best anchor and is still
    // independent of styling. See docs/selector-strategy.md, tier 2.
    this.alert = page.getByRole('alert');
  }

  /** Fill every field. Does not submit, so negative tests can inspect first. */
  async fill(user: UserPayload): Promise<void> {
    await this.nome.fill(user.nome);
    await this.email.fill(user.email);
    await this.password.fill(user.password);
    if (user.administrador === 'true') await this.administradorCheckbox.check();
    else await this.administradorCheckbox.uncheck();
  }

  async submitForm(): Promise<void> {
    await this.submit.click();
  }

  /** Fill and submit. The common arrange step. */
  async register(user: UserPayload): Promise<void> {
    await this.fill(user);
    await this.submitForm();
  }
}
