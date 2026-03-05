export function parsePagination(
  query: Record<string, unknown>,
  defaultLimit = 20
) {
  const page = Math.max(1, parseInt(query.page as string, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(query.limit as string, 10) || defaultLimit)
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}
