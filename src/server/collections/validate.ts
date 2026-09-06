// Collection validation mirroring PocketBase core/collection_validate.go (codes and messages).
import type { FieldErrors } from "../errors";
import { compileFilter, FilterError } from "../filter/compile";
import { FilterSyntaxError } from "../filter/lexer";
import { parseIndex } from "./ddl";
import { FIELD_TYPES, isFieldType, type Field } from "./fields";
import type { Collection } from "./model";

type Errs = Record<string, unknown>; // nested: { name: {code,message}, fields: { "1": { name: {...} } } }
const err = (code: string, message: string) => ({ code, message });

const NAME_RE = /^\w+$/;
const ID_RE = /^[^@#$&|.,'"\\/\s]+$/;
const RESERVED_FIELD_NAMES = ["collectionId", "collectionName", "expand"];
const RESERVED_AUTH_KEYS = ["passwordConfirm", "oldPassword"];
const INTERNAL_TABLES = ["_collections", "_params", "_migrations", "_pbMigrations", "_void_migrations", "_changes", "_realtime_clients", "_logs"];

export interface ValidateContext {
  all: Collection[]; // every known collection (including ones being imported in the same batch)
  usedIndexNames: Map<string, string>; // lowercase index name -> table name (from sqlite_master)
}

export function validateCollection(c: Collection, old: Collection | null, ctx: ValidateContext): Errs {
  const errs: Errs = {};
  const isNew = !old;

  const nameErr = validateName(c, old, ctx);
  if (nameErr) errs.name = nameErr;

  if (!c.id) errs.id = err("validation_required", "Cannot be blank.");
  else if (isNew && (c.id.length > 100 || !ID_RE.test(c.id))) errs.id = err("validation_match_invalid", "Must be in a valid format.");
  else if (isNew && !nameErr && ctx.all.some((x) => x !== c && x.id === c.id)) errs.id = err("validation_invalid_id", "The model id is invalid or already exists.");
  else if (!isNew && c.id !== old.id) errs.id = err("validation_values_mismatch", "Values don't match.");

  if (!isNew && c.system !== old.system) errs.system = err("validation_collection_system_flag_change", "System collection state cannot be changed.");

  if (!c.type) errs.type = err("validation_required", "Cannot be blank.");
  else if (!["base", "auth", "view"].includes(c.type)) errs.type = err("validation_in_invalid", "Must be a valid value.");
  else if (!isNew && c.type !== old.type) errs.type = err("validation_collection_type_change", "Collection type cannot be changed.");

  const fieldsErr = validateFields(c, old);
  if (fieldsErr) errs.fields = fieldsErr;

  const idxErr = validateIndexes(c, old, ctx);
  if (idxErr) errs.indexes = idxErr;

  // API rules: view collections cannot have write rules (ozzo Nil), every rule must compile against the
  // collection's own fields (checkRule), system collection rules are frozen (ensureNoSystemRuleChange).
  const frozen = !isNew && old.system;
  const ruleChange = (nv: unknown, ov: unknown) => (frozen && (nv ?? null) !== (ov ?? null) ? err("validation_collection_system_rule_change", "System collection API rule cannot be changed.") : null);
  for (const k of ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"] as const) {
    const v = (c[k] ?? null) as string | null;
    if (c.type === "view" && k !== "listRule" && k !== "viewRule" && v !== null) errs[k] = err("validation_nil", "Must be blank.");
    else errs[k] = ruleError(v, c, ctx) ?? ruleChange(v, old?.[k]);
    if (!errs[k]) delete errs[k];
  }
  if (c.type === "auth") {
    const opts = c.options as { authRule?: string | null; manageRule?: string | null; mfa?: { enabled?: boolean; rule?: string } };
    const oldOpts = (old?.options ?? {}) as typeof opts;
    const authRuleErr = ruleError(opts.authRule ?? null, c, ctx) ?? ruleChange(opts.authRule, oldOpts.authRule);
    if (authRuleErr) errs.authRule = authRuleErr;
    const manageRuleErr = opts.manageRule === "" ? err("validation_nil_or_not_empty_required", "Cannot be blank.") : ruleError(opts.manageRule ?? null, c, ctx) ?? ruleChange(opts.manageRule, oldOpts.manageRule);
    if (manageRuleErr) errs.manageRule = manageRuleErr;
    // collection_model_auth_options.go returns the struct errors first; the mfa rule is only checked after they pass
    const mfaRule = opts.mfa?.rule ?? "";
    if (opts.mfa?.enabled && mfaRule && !authRuleErr && !manageRuleErr) { const e = ruleError(mfaRule, c, ctx) ?? ruleChange(mfaRule, oldOpts.mfa?.rule ?? ""); if (e) errs.mfa = { rule: e }; }
  }
  // Go serializes validation.Errors (a map) with sorted keys
  return Object.fromEntries(Object.entries(errs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// core/collection_validate.go checkRule: a dry compile with an empty request (no auth) - the same resolver the
// records API uses, so unknown fields, bad relation paths and syntax errors surface at save time.
function ruleError(rule: string | null, c: Collection, ctx: ValidateContext) {
  if (rule === null || rule === "") return null;
  const collections = new Map<string, Collection>();
  for (const x of ctx.all) { collections.set(x.id, x); collections.set(x.name, x); }
  try {
    compileFilter(rule, { base: c, collections, request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" }, allowHiddenFields: true });
    return null;
  } catch (e) {
    // search.FilterData.BuildExpr: parse failures collapse to one message; resolver failures keep their text
    const raw = e instanceof FilterSyntaxError ? "invalid or incomplete filter expression" : e instanceof FilterError ? e.message : null;
    if (raw === null) throw e;
    return err("validation_invalid_rule", `Invalid rule. Raw error: ${/[.!?]$/.test(raw) ? raw : raw + "."}`);
  }
}

function validateName(c: Collection, old: Collection | null, ctx: ValidateContext) {
  if (!c.name) return err("validation_required", "Cannot be blank.");
  if (c.name.length > 255) return err("validation_length_out_of_range", "The length must be between 1 and 255.");
  if (c.name.includes("_via_")) return err("validation_found_via", `The value cannot contain "_via_".`);
  if (!NAME_RE.test(c.name)) return err("validation_match_invalid", "Must be in a valid format.");
  if (old?.system && old.name !== c.name) return err("validation_collection_system_name_change", "System collection name cannot be changed.");
  const lower = c.name.toLowerCase();
  if (ctx.all.some((x) => x !== c && x.name.toLowerCase() === lower)) {
    return err("validation_collection_name_exists", "Collection name must be unique (case insensitive).");
  }
  if (ctx.all.some((x) => x !== c && x.id.toLowerCase() === lower)) {
    return err("validation_collection_name_id_duplicate", "The name must not match an existing collection id.");
  }
  if (INTERNAL_TABLES.some((t) => t.toLowerCase() === lower) || lower.startsWith("sqlite_")) {
    return err("validation_collection_name_invalid", "The name shouldn't match with an existing internal table.");
  }
  return null;
}

function validateFields(c: Collection, old: Collection | null): Errs | { code: string; message: string } | null {
  const fields = c.fields as Field[];
  const ids = new Set<string>();
  const names = new Set<string>();
  const perField: Errs = {};
  const exclude = [...RESERVED_FIELD_NAMES, ...(c.type === "auth" ? [] : [])];

  fields.forEach((f, i) => {
    const fe: Errs = {};
    if (!f.type || !isFieldType(f.type)) fe.type = err("validation_in_invalid", `Must be one of ${FIELD_TYPES.join(", ")}.`);
    if (ids.has(f.id)) return void (perField[String(i)] = { id: err("validation_duplicated_field_id", `Duplicated or invalid field id "${f.id}"`) });
    ids.add(f.id);
    const lower = f.name.toLowerCase();
    if (names.has(lower)) return void (perField[String(i)] = { name: err("validation_duplicated_field_name", `Duplicated or invalid field name ${f.name}`) });
    names.add(lower);
    if (!f.name) fe.name = err("validation_required", "Cannot be blank.");
    else if (f.name.length > 100) fe.name = err("validation_length_out_of_range", "The length must be between 1 and 100.");
    else if (!NAME_RE.test(f.name)) fe.name = err("validation_match_invalid", "Must be in a valid format.");
    else if (exclude.includes(f.name)) fe.name = err("validation_not_in_invalid", "Must not be in list.");
    else if (f.name.includes("_via_")) fe.name = err("validation_found_via", `The value cannot contain "_via_".`);
    else if (c.type === "auth" && RESERVED_AUTH_KEYS.includes(f.name)) fe.name = err("validation_reserved_field_name", "The field name is reserved and cannot be used.");
    if (f.help && String(f.help).length > 300) fe.help = err("validation_length_out_of_range", "The length must be between 0 and 300.");
    if (old) {
      const of = (old.fields as Field[]).find((x) => x.id === f.id);
      if (of && of.type !== f.type) fe.type = err("validation_field_type_change", "Field type cannot be changed.");
    }
    Object.assign(fe, fieldSettingsErrors(f, c));
    if (Object.keys(fe).length) perField[String(i)] = fe;
  });
  if (Object.keys(perField).length) return perField;

  if (c.type !== "view") {
    const pk = fields.find((f) => f.name === "id");
    if (!pk || pk.type !== "text" || !pk.primaryKey || !pk.system) return err("validation_missing_primary_key", `Missing or invalid "id" PK field.`);
    if (c.type === "auth") {
      const need: Array<[string, string, string]> = [
        ["password", "password", "validation_missing_password_field"],
        ["tokenKey", "text", "validation_missing_tokenKey_field"],
        ["email", "email", "validation_missing_email_field"],
        ["emailVisibility", "bool", "validation_missing_emailVisibility_field"],
        ["verified", "bool", "validation_missing_verified_field"],
      ];
      for (const [name, type, code] of need) {
        const f = fields.find((x) => x.name === name);
        if (!f || f.type !== type || !f.system) return err(code, `System "${name}" field is required.`);
      }
    }
    if (old) {
      for (const of of old.fields as Field[]) {
        if (!of.system) continue;
        const nf = fields.find((x) => x.id === of.id);
        if (!nf || nf.name !== of.name) return err("validation_system_field_change", "System fields cannot be deleted or renamed.");
      }
    }
  }
  return null;
}

function fieldSettingsErrors(f: Field, c: Collection): Errs {
  const e: Errs = {};
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  switch (f.type) {
    case "text":
      if (f.primaryKey && f.name !== "id") e.name = err("validation_in_invalid", "Must be a valid value.");
      if ((n(f.min) ?? 0) < 0) e.min = err("validation_min_greater_equal_than_required", "Must be no less than 0.");
      if ((n(f.max) ?? 0) < 0 || ((n(f.max) ?? 0) > 0 && (n(f.max) ?? 0) < (n(f.min) ?? 0))) e.max = err("validation_min_greater_equal_than_required", `Must be no less than ${n(f.min) ?? 0}.`);
      break;
    case "number":
      if (f.onlyInt) {
        if (n(f.min) !== null && !Number.isInteger(n(f.min))) e.min = err("validation_only_int_constraint", "Must be an integer.");
        if (n(f.max) !== null && !Number.isInteger(n(f.max))) e.max = err("validation_only_int_constraint", "Must be an integer.");
      }
      if (n(f.min) !== null && n(f.max) !== null && (n(f.max) as number) < (n(f.min) as number)) e.max = err("validation_min_greater_equal_than_required", `Must be no less than ${n(f.min)}.`);
      break;
    case "select": {
      const values = Array.isArray(f.values) ? f.values : [];
      if (values.length === 0) e.values = err("validation_required", "Cannot be blank.");
      if ((n(f.maxSelect) ?? 0) < 0 || (n(f.maxSelect) ?? 0) > values.length) e.maxSelect = err("validation_max_less_equal_than_required", `Must be no greater than ${values.length}.`);
      break;
    }
    case "file":
      if ((n(f.maxSelect) ?? 0) < 0) e.maxSelect = err("validation_min_greater_equal_than_required", "Must be no less than 0.");
      if ((n(f.maxSize) ?? 0) < 0) e.maxSize = err("validation_min_greater_equal_than_required", "Must be no less than 0.");
      break;
    case "relation":
      if (!f.collectionId) e.collectionId = err("validation_required", "Cannot be blank.");
      if ((n(f.minSelect) ?? 0) < 0) e.minSelect = err("validation_min_greater_equal_than_required", "Must be no less than 0.");
      if ((n(f.maxSelect) ?? 0) < 0 || ((n(f.maxSelect) ?? 0) > 0 && (n(f.maxSelect) ?? 0) < (n(f.minSelect) ?? 0))) e.maxSelect = err("validation_min_greater_equal_than_required", `Must be no less than ${n(f.minSelect) ?? 0}.`);
      break;
    case "editor": case "json":
      if ((n(f.maxSize) ?? 0) < 0) e.maxSize = err("validation_min_greater_equal_than_required", "Must be no less than 0.");
      break;
    case "password": {
      // ozzo-validation skips zero values for Min/Max, so 0 means "unset"
      const min = n(f.min) ?? 0;
      const max = n(f.max) ?? 0;
      if (min !== 0 && (min < 1 || min > 71)) e.min = err("validation_min_greater_equal_than_required", "Must be between 1 and 71.");
      if (max !== 0 && (max < min || max > 71)) e.max = err("validation_max_less_equal_than_required", `Must be between ${min} and 71.`);
      break;
    }
    case "autodate":
      if (!f.onCreate && !f.onUpdate) e.onCreate = err("validation_required", "Cannot be blank.");
      break;
    case "date":
      if (f.min && f.max && String(f.max) < String(f.min)) e.max = err("validation_min_greater_equal_than_required", `Must be no less than ${f.min}.`);
      break;
  }
  void c;
  return e;
}

function validateIndexes(c: Collection, old: Collection | null, ctx: ValidateContext): Errs | { code: string; message: string } | null {
  if (c.type === "view" && c.indexes.length > 0) return err("validation_indexes_not_supported", "View collections don't support indexes.");
  const names = new Set<string>();
  const defs = new Set<string>();
  const per: Errs = {};
  c.indexes.forEach((raw, i) => {
    const p = parseIndex(raw);
    if (!p || !p.name || !p.columns) return void (per[String(i)] = err("validation_invalid_index_expression", "Invalid CREATE INDEX expression."));
    const lower = p.name.toLowerCase();
    if (names.has(lower)) return void (per[String(i)] = err("validation_duplicated_index_name", "The index name already exists."));
    names.add(lower);
    const usedBy = ctx.usedIndexNames.get(lower);
    if (usedBy && usedBy.toLowerCase() !== c.name.toLowerCase() && usedBy.toLowerCase() !== (old?.name ?? "").toLowerCase()) {
      return void (per[String(i)] = err("validation_existing_index_name", `The index name is already used in ${usedBy} collection.`));
    }
    const def = `${p.unique}|${p.columns.replace(/\s+/g, "").toLowerCase()}|${p.where.toLowerCase()}`;
    if (defs.has(def)) return void (per[String(i)] = err("validation_duplicated_index_definition", "The index definition already exists."));
    defs.add(def);
  });
  return Object.keys(per).length ? per : null;
}
