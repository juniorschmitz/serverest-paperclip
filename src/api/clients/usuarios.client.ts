import { expect } from '@playwright/test';
import type { ApiClient, ApiResponse } from '../api-client';
import { Endpoints } from '../endpoints';
import type { CreatedBody, MessageBody, Usuario, UsuarioListBody } from '../types';
import { buildUser, credentialsOf, type Credentials, type UserPayload } from '@/data/factories';
import type { ResourceRegistry } from '@/support/resource-registry';

/** A user this test created, plus everything needed to act as them. */
export interface SeededUser {
  id: string;
  payload: UserPayload;
  credentials: Credentials;
}

/**
 * Two kinds of method here, and the split is deliberate:
 *
 *   raw operations (create, list, getById, update, remove) send the request and
 *   return it unjudged. No assertions, no cleanup tracking. Negative tests need
 *   to see a 400 without the helper having thrown first.
 *
 *   seed() arranges state. It asserts success, registers teardown, and returns
 *   a typed handle. Use it for the "given a user exists" part of a test, never
 *   for the part under test.
 *
 * Mixing the two is how suites end up with helpers that assert 201 inside the
 * arrange step of a test whose whole point is that it should be a 400.
 */
export class UsuariosClient {
  constructor(
    private readonly api: ApiClient,
    private readonly registry: ResourceRegistry,
  ) {}

  create(body: unknown): Promise<ApiResponse<CreatedBody & MessageBody>> {
    return this.api.post(Endpoints.usuarios, { body });
  }

  list(query?: Record<string, string>): Promise<ApiResponse<UsuarioListBody>> {
    return this.api.get(Endpoints.usuarios, { query });
  }

  getById(id: string): Promise<ApiResponse<Usuario | MessageBody>> {
    return this.api.get(Endpoints.usuarioById, { pathParams: { _id: id } });
  }

  update(id: string, body: unknown): Promise<ApiResponse<MessageBody & Partial<CreatedBody>>> {
    return this.api.put(Endpoints.usuarioById, { pathParams: { _id: id }, body });
  }

  remove(id: string): Promise<ApiResponse<MessageBody>> {
    return this.api.delete(Endpoints.usuarioById, { pathParams: { _id: id } });
  }

  /**
   * Create a valid user and register its deletion.
   *
   * Deletion goes out unauthenticated because the API genuinely allows it —
   * `/usuarios` write operations declare no security requirement, verified
   * against the live instance. That is itself the top item on the risk register
   * (R1); teardown just takes advantage of it. If that ever changes, this is
   * the one place to fix.
   */
  async seed(overrides: Partial<UserPayload> = {}): Promise<SeededUser> {
    const payload = buildUser(overrides);
    const res = await this.create(payload);

    expect(
      res.status,
      `Seeding a user failed: POST /usuarios -> ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(201);
    expect(res.body._id, 'POST /usuarios returned 201 with no _id').toBeTruthy();

    const id = res.body._id;
    this.registry.track('usuario', `${id} (${payload.email})`, async () => {
      const del = await this.api.anonymous().delete(Endpoints.usuarioById, {
        pathParams: { _id: id },
      });
      if (del.status >= 400) {
        throw new Error(`DELETE /usuarios/${id} -> ${del.status} ${JSON.stringify(del.body)}`);
      }
    });

    return { id, payload, credentials: credentialsOf(payload) };
  }
}
