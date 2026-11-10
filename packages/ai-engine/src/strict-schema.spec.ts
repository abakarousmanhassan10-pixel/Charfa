import { toStrictJsonSchema } from './strict-schema';
import { businessAnalysisSchema, contentSchema, marketingStrategySchema, productAnalysisSchema } from './schemas';

function visit(node: unknown, fn: (n: Record<string, unknown>) => void) {
  if (Array.isArray(node)) node.forEach((n) => visit(n, fn));
  else if (node && typeof node === 'object') {
    fn(node as Record<string, unknown>);
    Object.values(node as object).forEach((v) => visit(v, fn));
  }
}

describe('toStrictJsonSchema', () => {
  it.each([
    ['business', businessAnalysisSchema],
    ['product', productAnalysisSchema],
    ['strategy', marketingStrategySchema],
    ['content', contentSchema],
  ])('%s schema is closed, fully required and has no unsupported keywords', (_n, schema) => {
    const json = toStrictJsonSchema(schema);
    expect(json.type).toBe('object');
    visit(json, (n) => {
      if (n.type === 'object' && n.properties) {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      }
      for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', '$ref', 'default']) expect(n).not.toHaveProperty(k);
    });
  });

  it('keeps nullable fields as explicit null types', () => {
    const json = toStrictJsonSchema(contentSchema) as { properties: Record<string, { type?: unknown; anyOf?: unknown }> };
    expect(JSON.stringify(json.properties.title)).toContain('null');
  });
});
