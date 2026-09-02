/**
 * Response shapes.
 *
 * Note the `@deprecated` markers on every `quantidade` list field. They are not
 * really deprecated — the API returns them and the contract tests need them.
 * The marker is a guard rail: this is a shared public sandbox, other people are
 * creating and deleting records while we run, and any assertion on a global
 * count is guaranteed to flake eventually. `@deprecated` makes the field strike
 * through in the editor and trip a lint rule, so reaching for it is a decision
 * rather than an accident. Assert containment by id instead — see
 * src/support/assertions.ts.
 */

export interface MessageBody {
  message: string;
}

export interface CreatedBody extends MessageBody {
  _id: string;
}

export interface LoginBody extends MessageBody {
  authorization: string;
}

export interface Usuario {
  nome: string;
  email: string;
  password: string;
  administrador: string;
  _id: string;
}

export interface UsuarioListBody {
  /** @deprecated Global count on a shared instance — assert containment by id instead. */
  quantidade: number;
  usuarios: Usuario[];
}

export interface Produto {
  nome: string;
  preco: number;
  descricao: string;
  quantidade: number;
  _id: string;
}

export interface ProdutoListBody {
  /** @deprecated Global count on a shared instance — assert containment by id instead. */
  quantidade: number;
  produtos: Produto[];
}

export interface CarrinhoProduto {
  idProduto: string;
  quantidade: number;
  precoUnitario: number;
}

export interface Carrinho {
  produtos: CarrinhoProduto[];
  precoTotal: number;
  quantidadeTotal: number;
  idUsuario: string;
  _id: string;
}

export interface CarrinhoListBody {
  /** @deprecated Global count on a shared instance — assert containment by id instead. */
  quantidade: number;
  carrinhos: Carrinho[];
}
