'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL, buildInput, classifyWithOpenAI, processJob, referenceKpi } = require('../lib/form-ai');

test('only text, work type and source are sent to the API; no identifying columns', async () => {
  const input = buildInput('survey', {
    name: '本名', address: '大分市実在町1', phone: '0971234567',
    source: 'meishi', message: '外壁塗装の見積をお願いします。 090-1234-5678'
  });
  assert.equal(input.name, undefined);
  assert.equal(input.address, undefined);
  assert.equal(input.phone, undefined);
  assert.equal(input.formType, 'survey');
  assert.doesNotMatch(input.text, /090-1234-5678/);
  const result = await classifyWithOpenAI(input, {
    apiKey: 'test-only',
    httpClient: { post: async (url, payload) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(payload.store, false);
      assert.equal(payload.model, MODEL);
      const sent = JSON.stringify(payload.input);
      assert.doesNotMatch(sent, /本名|大分市実在町|0971234567/);
      return { data: { model: MODEL, output: [
        { content: [{ type: 'output_text', text: JSON.stringify({
          decision: 'customer', reason: '外壁塗装の見積依頼'
        }) }] }
      ] } };
    } }
  });
  assert.deepEqual(result, {
    decision: 'customer', reason: '外壁塗装の見積依頼', model: MODEL
  });
});

test('fake examples of customer, sales and unknown flow through the model boundary', async () => {
  const samples = [
    ['外壁の色あせを直したい。見積もりをください', 'customer'],
    ['雨漏りした屋上の防水工事を相談したい', 'customer'],
    ['自社のSEO対策を月額でご提案します', 'sales'],
    ['採用支援サービスの営業です。面談をお願いします', 'sales'],
    ['詳しい話を聞きたいです', 'unknown'],
    ['塗装の相談か商品提案か、まだ決めていません', 'unknown']
  ];
  for (const [text, expected] of samples) {
    const input = buildInput('other', { detail: text, works: ['塗装'], source: '' });
    const decision = expected; // API response stub: contract test, not model-quality evaluation.
    const output = await classifyWithOpenAI(input, {
      apiKey: 'test-only',
      httpClient: { post: async () => ({ data: { model: MODEL, output: [
        { content: [{ type: 'output_text', text: JSON.stringify({
          decision, reason: '架空データのテスト'
        }) }] }
      ] } }) }
    });
    assert.equal(output.decision, expected);
  }
});

function database(original) {
  const results = new Map();
  return {
    results,
    collection(name) {
      if (name === 'form_ai_classifications') return {
        doc(id) { return {
          async get() { return { exists: results.has(id) }; },
          async create(data) {
            if (results.has(id)) throw Object.assign(new Error('duplicate'), { code: 6 });
            results.set(id, data);
          }
        }; }
      };
      return { doc() { return { get: async () => ({
        exists: !!original, data: () => original
      }) }; } };
    }
  };
}

test('separate worker records once and failed AI is unknown; no test rows', async () => {
  const db = database({ message: '外壁塗装の相談', source: 'meishi', test_event: false });
  const job = { collection: 'submissions', submissionId: 'docA', receivedDay: '2026-09-26' };
  let calls = 0;
  const deps = {
    classifier: async () => { calls++; throw new Error('API offline'); },
    serverTimestamp: () => 'unit-time'
  };
  assert.deepEqual(await processJob(db, 'submissions_docA', job, deps), {
    created: true, decision: 'unknown'
  });
  assert.deepEqual(await processJob(db, 'submissions_docA', job, deps), { duplicate: true });
  assert.equal(calls, 1);
  const stored = db.results.get('submissions_docA');
  assert.equal(stored.decision, 'unknown');
  assert.equal(stored.reason, 'AI判定に失敗しました');
  assert.equal(stored.model, MODEL);
  assert.equal(stored.sourceId, 'docA');
  assert.equal(stored.classifiedAt, 'unit-time');
  const testDb = database({ message: '作動確認', test_event: true });
  assert.deepEqual(await processJob(testDb, 'test', job, deps), { skipped: true });
  assert.equal(testDb.results.size, 0);
});

test('duplicate parallel work cannot create two results or double-count', async () => {
  const db = database({ message: '外壁の相談', source: 'area_check_v1' });
  const job = { collection: 'submissions', submissionId: 'same', receivedDay: '2026-09-26' };
  const deps = { classifier: async () => ({
    decision: 'customer', reason: '工事相談', model: MODEL
  }), serverTimestamp: () => 'unit-time' };
  await Promise.all([
    processJob(db, 'submissions_same', job, deps),
    processJob(db, 'submissions_same', job, deps)
  ]);
  assert.equal(db.results.size, 1);
  assert.deepEqual(referenceKpi([...db.results.values(), {
    decision: 'customer', source: 'meishi', test_event: true
  }]), {
    label: 'AI判定のお客様フォーム件数（参考）',
    status: 'reference',
    total: 1,
    byMedia: [{ code: 'area_check_v1', count: 1 }]
  });
});