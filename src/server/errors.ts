// PocketBase error envelope: { status, message, data }
// data holds per-field validation errors: { field: { code, message } }
export type FieldErrors = Record<string, { code: string; message: string }>;

// PocketBase passes messages through inflector.Sentenize: capitalized, ending with punctuation.
export function sentenize(message: string): string {
  const m = message.trim();
  if (!m) return m;
  const cap = m[0]!.toUpperCase() + m.slice(1);
  return /[.!?]$/.test(cap) ? cap : cap + ".";
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: FieldErrors | Record<string, unknown> = {},
  ) {
    super(sentenize(message));
  }
  toJSON() {
    return { data: this.data, message: this.message, status: this.status };
  }
  response() {
    return Response.json(this.toJSON(), { status: this.status });
  }
}

export const badRequest = (message = "Something went wrong while processing your request.", data: FieldErrors = {}) =>
  new ApiError(400, message, data);
export const unauthorized = (message = "The request requires valid record authorization token.") => new ApiError(401, message);
export const forbidden = (message = "You are not allowed to perform this request.") => new ApiError(403, message);
export const notFound = (message = "The requested resource wasn't found.") => new ApiError(404, message);
export const internal = (message = "Something went wrong while processing your request.") => new ApiError(500, message);

export const validationFailed = (data: FieldErrors) =>
  badRequest("An error occurred while validating the submitted data.", data);

export const V = {
  required: { code: "validation_required", message: "Cannot be blank." },
  length: (min: number, max: number) => ({
    code: "validation_length_out_of_range",
    message: `The length must be between ${min} and ${max}.`,
  }),
  invalidFormat: { code: "validation_invalid_format", message: "Invalid format." },
};
