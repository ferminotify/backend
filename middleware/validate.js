/**
 * Express middleware factory: validate (and normalise) `req.body` against a
 * Zod schema. On failure responds `400` with the first issue's message — the
 * same single-message shape the hand-written checks used to return. On success
 * `req.body` is replaced with the parsed/transformed data (trimmed, lowercased).
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0].message });
    }
    req.body = result.data;
    next();
  };
}
