// 도구 결과(JSON) 도우미: 문서 도구 결과 맨 위의 doc(SPEC-007)을 확인하고 뺀다.
// 문서 하나로 쓰던 테스트의 기대(doc 없는 결과 모양)를 그대로 두고, doc 이 결과 맨 위에 있는지는 여기서 늘 확인한다.

/** doc 이 있으면 맨 위 문자열인지 확인하고 뺀 나머지. 없으면(list_documents 등) 그대로 */
export function withoutDoc(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('doc' in value)) return value;
  const [first] = Object.keys(value);
  if (first !== 'doc' || typeof value.doc !== 'string') throw new Error(`doc 이 결과 맨 위 문서 이름이 아닙니다: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'doc'));
}
