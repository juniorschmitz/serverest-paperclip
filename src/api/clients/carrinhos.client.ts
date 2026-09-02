import { expect } from '@playwright/test';
import type { ApiClient, ApiResponse } from '../api-client';
import { Endpoints } from '../endpoints';
import type { Carrinho, CarrinhoListBody, CreatedBody, MessageBody } from '../types';
import type { CartItem } from '@/data/factories';
import type { ResourceRegistry } from '@/support/resource-registry';

export interface SeededCart {
  id: string;
  items: CartItem[];
}

/**
 * Carts are the only stateful domain in the app, and the rules matter for
 * teardown as much as for testing:
 *
 *   - one cart per user, so a test that needs a second cart needs a second user
 *   - concluir-compra completes the purchase and does NOT return stock
 *   - cancelar-compra abandons it and DOES return stock
 *   - a user who owns a cart cannot be deleted
 *   - a product in a cart cannot be deleted
 *
 * Teardown therefore cancels rather than concludes: cancelling restores the
 * stock we borrowed and leaves the sandbox as we found it. If the test already
 * concluded the purchase, the cancel is a no-op the API answers cheerfully, and
 * the registry treats that as success.
 */
export class CarrinhosClient {
  constructor(
    private readonly api: ApiClient,
    private readonly registry: ResourceRegistry,
  ) {}

  create(body: unknown): Promise<ApiResponse<CreatedBody & MessageBody>> {
    return this.api.post(Endpoints.carrinhos, { body });
  }

  list(query?: Record<string, string>): Promise<ApiResponse<CarrinhoListBody>> {
    return this.api.get(Endpoints.carrinhos, { query });
  }

  getById(id: string): Promise<ApiResponse<Carrinho | MessageBody>> {
    return this.api.get(Endpoints.carrinhoById, { pathParams: { _id: id } });
  }

  /** Completes the purchase. Stock is not returned. */
  concluirCompra(): Promise<ApiResponse<MessageBody>> {
    return this.api.delete(Endpoints.concluirCompra);
  }

  /** Abandons the cart. Stock is returned. */
  cancelarCompra(): Promise<ApiResponse<MessageBody>> {
    return this.api.delete(Endpoints.cancelarCompra);
  }

  /**
   * Create a cart for the identity this client is bound to, and register its
   * cancellation. Registered as kind 'carrinho' so it is torn down before the
   * products it references and the user that owns it.
   */
  async seed(items: CartItem[]): Promise<SeededCart> {
    const res = await this.create({ produtos: items });

    expect(
      res.status,
      `Seeding a cart failed: POST /carrinhos -> ${res.status} ${JSON.stringify(res.body)}. ` +
        `"Não é permitido ter mais de 1 carrinho" means this identity already has one — ` +
        `seed a fresh user instead of reusing this one.`,
    ).toBe(201);

    const id = res.body._id;
    const owner = this.api.identity?.email ?? 'anonymous';
    this.registry.track('carrinho', `${id} (owner ${owner})`, async () => {
      const cancelled = await this.cancelarCompra();
      // 200 covers both "cancelled" and "there was nothing to cancel", which is
      // the expected answer when the test concluded the purchase itself.
      if (cancelled.status >= 400) {
        throw new Error(
          `DELETE /carrinhos/cancelar-compra for ${owner} -> ${cancelled.status} ` +
            `${JSON.stringify(cancelled.body)}`,
        );
      }
    });

    return { id, items };
  }
}
