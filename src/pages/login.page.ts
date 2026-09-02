import type { Locator, Page } from '@playwright/test';
import type { Credentials } from '@/data/factories';
import { BasePage } from './base.page';

/** /login. Note the password field's testid is "senha" here but "password" on register. */
export class LoginPage extends BasePage {
  readonly path = '/login';

  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly registerLink: Locator;
  readonly alert: Locator;

  constructor(page: Page) {
    super(page);
    this.email = page.getByTestId('email');
    this.password = page.getByTestId('senha');
    this.submit = page.getByTestId('entrar');
    this.registerLink = page.getByTestId('cadastrar');
    this.alert = page.getByRole('alert');
  }

  async login(creds: Credentials): Promise<void> {
    await this.email.fill(creds.email);
    await this.password.fill(creds.password);
    await this.submit.click();
  }
}
