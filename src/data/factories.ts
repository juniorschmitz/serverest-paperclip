import { uniqueEmail, uniqueName } from './identity';

/**
 * Request-body factories.
 *
 * Every factory returns a complete, valid payload with unique values, and takes
 * a partial override. Tests say what matters to them and inherit the rest:
 *
 *   const user = buildUser();                        // a valid admin
 *   const user = buildUser({ administrador: 'false' }); // a valid non-admin
 *   const user = buildUser({ email: 'nope' });       // one invalid field, rest valid
 *
 * That last form is the point: a negative test that hand-writes a whole payload
 * ends up testing several violations at once and stops proving anything.
 */

export interface UserPayload {
  nome: string;
  email: string;
  password: string;
  /** ServeRest models this as the *string* "true"/"false", not a boolean. */
  administrador: 'true' | 'false';
}

export interface ProductPayload {
  nome: string;
  preco: number;
  descricao: string;
  quantidade: number;
}

export interface CartItem {
  idProduto: string;
  quantidade: number;
}

export interface CartPayload {
  produtos: CartItem[];
}

export function buildUser(overrides: Partial<UserPayload> = {}): UserPayload {
  return {
    nome: uniqueName('Usuario Teste'),
    email: uniqueEmail(),
    password: 'Str0ngPass!',
    administrador: 'true',
    ...overrides,
  };
}

/** Convenience for the common "a non-admin" case, so tests do not restate the string. */
export function buildRegularUser(overrides: Partial<UserPayload> = {}): UserPayload {
  return buildUser({ administrador: 'false', ...overrides });
}

export function buildProduct(overrides: Partial<ProductPayload> = {}): ProductPayload {
  return {
    // Product name is globally unique on the instance — see identity.ts.
    nome: uniqueName('Produto Teste'),
    preco: 100,
    descricao: 'Produto criado por teste automatizado da Testing CIA',
    quantidade: 50,
    ...overrides,
  };
}

export function buildCart(items: CartItem[]): CartPayload {
  return { produtos: items };
}

/** Login credentials — the pair every auth path needs. */
export interface Credentials {
  email: string;
  password: string;
}

export function credentialsOf(user: UserPayload): Credentials {
  return { email: user.email, password: user.password };
}
