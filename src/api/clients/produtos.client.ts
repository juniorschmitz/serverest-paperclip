import { expect } from '@playwright/test';
import type { ApiClient, ApiResponse } from '../api-client';
import { Endpoints } from '../endpoints';
import type { CreatedBody, MessageBody, Produto, ProdutoListBody } from '../types';
import { buildProduct, type ProductPayload } from '@/data/factories';
import type { ResourceRegistry } from '@/support/resource-registry';

export interface SeededProduct {
  id: string;
  payload: ProductPayload;
}

/** See UsuariosClient for the raw-vs-seed split. */
export class ProdutosClient {
  constructor(
    private readonly api: ApiClient,
    private readonly registry: ResourceRegistry,
  ) {}

  create(body: unknown): Promise<ApiResponse<CreatedBody & MessageBody>> {
    return this.api.post(Endpoints.produtos, { body });
  }

  list(query?: Record<string, string>): Promise<ApiResponse<ProdutoListBody>> {
    return this.api.get(Endpoints.produtos, { query });
  }

  getById(id: string): Promise<ApiResponse<Produto | MessageBody>> {
    return this.api.get(Endpoints.produtoById, { pathParams: { _id: id } });
  }

  update(id: string, body: unknown): Promise<ApiResponse<MessageBody & Partial<CreatedBody>>> {
    return this.api.put(Endpoints.produtoById, { pathParams: { _id: id }, body });
  }

  remove(id: string): Promise<ApiResponse<MessageBody>> {
    return this.api.delete(Endpoints.produtoById, { pathParams: { _id: id } });
  }

  /**
   * Create a valid product and register its deletion.
   *
   * Product writes require an admin token, so this uses whichever identity the
   * client is bound to — seed with an admin client. Deletion is registered
   * against the same identity, and runs after carts are cleared, because the
   * API refuses to delete a product that sits in someone's cart.
   */
  async seed(overrides: Partial<ProductPayload> = {}): Promise<SeededProduct> {
    const payload = buildProduct(overrides);
    const res = await this.create(payload);

    expect(
      res.status,
      `Seeding a product failed: POST /produtos -> ${res.status} ${JSON.stringify(res.body)}. ` +
        `A 401 here means the seeding client is not an admin; a 400 means the generated ` +
        `name collided, which should be impossible — see src/data/identity.ts.`,
    ).toBe(201);

    const id = res.body._id;
    this.registry.track('produto', `${id} (${payload.nome})`, async () => {
      const del = await this.remove(id);
      if (del.status >= 400) {
        throw new Error(`DELETE /produtos/${id} -> ${del.status} ${JSON.stringify(del.body)}`);
      }
    });

    return { id, payload };
  }
}
