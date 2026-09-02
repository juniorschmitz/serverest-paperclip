/**
 * Every path the API exposes, as an OpenAPI-style template.
 *
 * Templates, not interpolated strings, for two reasons: contract validation
 * looks operations up in the spec by templated path, and reports group by
 * operation instead of by concrete id. ApiClient does the interpolation.
 *
 * This is the whole surface — 16 operations. Kept in one list so coverage can
 * be reported against it as a checklist.
 */
export const Endpoints = {
  login: '/login',

  usuarios: '/usuarios',
  usuarioById: '/usuarios/{_id}',

  produtos: '/produtos',
  produtoById: '/produtos/{_id}',

  carrinhos: '/carrinhos',
  carrinhoById: '/carrinhos/{_id}',
  concluirCompra: '/carrinhos/concluir-compra',
  cancelarCompra: '/carrinhos/cancelar-compra',
} as const;

export type EndpointTemplate = (typeof Endpoints)[keyof typeof Endpoints];
