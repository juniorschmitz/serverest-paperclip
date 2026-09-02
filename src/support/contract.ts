import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { APIRequestContext } from '@playwright/test';
import { config } from '@/config/env';
import { withTransportRetry } from './retry';

/**
 * Contract validation against the live OpenAPI document.
 *
 * The API publishes a complete OpenAPI 3.0 spec at /swagger.json covering all
 * 16 operations. Validating every response against it costs one fetch per
 * worker and catches a class of regression no hand-written assertion will:
 * a field that changes type, a field that quietly disappears, a response that
 * grows a shape nobody expected.
 *
 * The spec is fetched live rather than vendored, deliberately — a vendored copy
 * validates against what the API used to be, which is the opposite of what we
 * want. If the deployed spec drifts from the deployed behaviour, that is itself
 * a finding.
 *
 * Default posture is report-not-fail (STRICT_CONTRACT=false). A shape mismatch
 * on an undocumented error status should not turn an otherwise valid functional
 * test red; it should show up in the report and get triaged. Set
 * STRICT_CONTRACT=true in a dedicated contract job to make drift a hard failure.
 */

export interface ContractResult {
  /** Did the spec document this method/path/status at all? */
  documented: boolean;
  /** True when documented and the body matched, or when nothing was documented. */
  ok: boolean;
  /** Human-readable ajv errors, empty when ok. */
  errors: string[];
  /** "POST /usuarios -> 201", for messages. */
  operation: string;
}

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OperationObject>>;
  components?: { responses?: Record<string, ResponseObject>; schemas?: Record<string, unknown> };
}

interface OperationObject {
  responses?: Record<string, ResponseObject>;
}

interface ResponseObject {
  $ref?: string;
  content?: Record<string, { schema?: unknown }>;
}

const SPEC_ID = 'serverest-spec';

export class ContractValidator {
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction | null>();
  /** Every operation+status seen that the spec does not document. */
  readonly undocumented = new Set<string>();
  /** Schemas the spec documents but ajv could not compile. Always a defect here. */
  readonly compileFailures = new Map<string, string>();

  private constructor(private readonly spec: OpenApiDoc) {
    // strict:false — an OpenAPI schema is not a JSON Schema draft-07 document.
    // It carries `nullable`, `example`, `xml` and friends, which ajv would
    // otherwise reject as unknown keywords.
    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
    addFormats(this.ajv);
    this.ajv.addSchema(spec as unknown as object, SPEC_ID);
  }

  static async load(
    request: APIRequestContext,
    apiBaseUrl: string = config().apiBaseUrl,
  ): Promise<ContractValidator> {
    // Retried only for connection-level failures — see support/retry.ts for why
    // that is not the same thing as retrying a test.
    const res = await withTransportRetry(() => request.get(`${apiBaseUrl}/swagger.json`), {
      label: `GET ${apiBaseUrl}/swagger.json (worker setup)`,
    });

    if (res.status() !== 200) {
      throw new Error(
        `Could not load the API contract: GET ${apiBaseUrl}/swagger.json returned ${res.status()}. ` +
          `Contract assertions cannot run without it.`,
      );
    }
    return new ContractValidator((await res.json()) as OpenApiDoc);
  }

  get info(): { title: string; version: string; operations: number } {
    let operations = 0;
    for (const methods of Object.values(this.spec.paths)) operations += Object.keys(methods).length;
    return { ...this.spec.info, operations };
  }

  /**
   * Compile every response schema the spec documents.
   *
   * Exists so a test can assert the validator is actually able to validate.
   * Without it, "no contract errors" is ambiguous between "everything matched"
   * and "nothing was ever checked" — and those look identical in a report.
   */
  compileAll(): { compiled: string[]; failed: Array<{ operation: string; reason: string }> } {
    const compiled: string[] = [];
    const failed: Array<{ operation: string; reason: string }> = [];

    for (const [path, methods] of Object.entries(this.spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const status of Object.keys(operation.responses ?? {})) {
          const label = `${method.toUpperCase()} ${path} -> ${status}`;
          if (!this.schemaPointer(method, path, Number(status))) continue;

          const before = this.compileFailures.size;
          const validator = this.validatorFor(method, path, Number(status));
          if (validator) compiled.push(label);
          else if (this.compileFailures.size > before)
            failed.push({ operation: label, reason: this.compileFailures.get(label) ?? 'unknown' });
        }
      }
    }

    return { compiled, failed };
  }

  /**
   * Validate a response body.
   *
   * `path` is the *templated* path from endpoints.ts ("/usuarios/{_id}"), not
   * the concrete one — that is why every request goes through ApiClient with a
   * template plus params rather than a pre-interpolated string.
   */
  validate(method: string, path: string, status: number, body: unknown): ContractResult {
    const operation = `${method.toUpperCase()} ${path} -> ${status}`;
    const validator = this.validatorFor(method, path, status);

    if (validator === null) {
      this.undocumented.add(operation);
      return { documented: false, ok: true, errors: [], operation };
    }

    const ok = validator(body);
    return {
      documented: true,
      ok,
      operation,
      errors: ok
        ? []
        : (validator.errors ?? []).map(
            (e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`,
          ),
    };
  }

  private validatorFor(method: string, path: string, status: number): ValidateFunction | null {
    const key = `${method.toLowerCase()} ${path} ${status}`;
    if (this.compiled.has(key)) return this.compiled.get(key) ?? null;

    const pointer = this.schemaPointer(method, path, status);
    let validator: ValidateFunction | null = null;
    if (pointer) {
      try {
        // Note the "#": `${SPEC_ID}${pointer}` without it is a *URI path*
        // ("serverest-spec/paths/..."), not a fragment, and ajv cannot resolve
        // it. It throws, every schema silently becomes "undocumented", and the
        // whole contract layer reports success while checking nothing. That bug
        // shipped and was caught by tests/scaffold/contract.api.spec.ts, which
        // exists precisely to keep it caught.
        validator = this.ajv.compile({ $ref: `${SPEC_ID}#${pointer}` });
      } catch (error) {
        // A schema that will not compile is recorded separately and loudly.
        // It must never be folded into "undocumented": that is what turned a
        // broken validator into a quiet no-op the first time.
        this.compileFailures.set(
          `${method.toUpperCase()} ${path} -> ${status}`,
          error instanceof Error ? error.message : String(error),
        );
        validator = null;
      }
    }
    this.compiled.set(key, validator);
    return validator;
  }

  /**
   * Walk paths -> method -> responses -> status, following a $ref at the
   * response level (components.responses) before reading content schema.
   * Returns a JSON pointer into the spec, or undefined when undocumented.
   */
  private schemaPointer(method: string, path: string, status: number): string | undefined {
    const operation = this.spec.paths?.[path]?.[method.toLowerCase()];
    if (!operation?.responses) return undefined;

    const responseKey = operation.responses[String(status)]
      ? String(status)
      : operation.responses['default']
        ? 'default'
        : undefined;
    if (!responseKey) return undefined;

    const response = operation.responses[responseKey];
    if (!response) return undefined;

    let base = `/paths/${escapePointer(path)}/${method.toLowerCase()}/responses/${escapePointer(responseKey)}`;
    let resolved: ResponseObject = response;

    if (response.$ref) {
      const name = response.$ref.replace('#/components/responses/', '');
      const target = this.spec.components?.responses?.[name];
      if (!target) return undefined;
      base = `/components/responses/${escapePointer(name)}`;
      resolved = target;
    }

    const media = resolved.content?.['application/json'];
    if (!media?.schema) return undefined;

    return `${base}/content/${escapePointer('application/json')}/schema`;
  }
}

/** RFC 6901: "~" -> "~0", "/" -> "~1". Path templates and media types need it. */
function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
