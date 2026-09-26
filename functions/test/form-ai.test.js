'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL, AI_DAILY_LIMIT, AI_MAX_INPUT_TOKENS, buildInput, classifyWithGemini, processJob, referenceKpi } = require('../lib/form-ai');

function fakeAuth(reply, check) {
  return { getClient: async () => ({ request: async (options) => {
    if (options.url.endsWith(':countTokens')) return { data: { totalTokens: 100 } };
    if (check) check(options);
    return { data: {
      modelVersion: MODEL,
      candidates: [{ finishReason: 'STOP', content: {
        parts: [{ text: JSON.stringify(reply) }]
      } }]
    } };
  } }) };
}

test('Vertex OAuth request sends only selected form fields, not identifying columns or an API key', async () => {
  const input = buildInput('survey', {
    name: '本名', address: '大分市実在町1', phone: '0971234567',
    source: 'meishi', message: '外壁塗装の見積をお願いします。 090-1234-5678'
  });
  assert.equal(input.name, undefined);
  assert.equal(input.address, undefined);
  assert.equal(input.phone, undefined);
  assert.doesNotMatch(input.text, /090-1234-5678/);
  const result = await classifyWithGemini(input, {
    auth: fakeAuth({ decision: 'customer', reason: '外壁塗装の見積依頼' }, options => {
      assert.equal(options.method, 'POST');
      assert.equal(options.url, 'https://aiplatform.googleapis.com/v1/projects/' +
        'aokitosou-miniapp/locations/global/publishers/google/models/' +
        MODEL + ':generateContent');
      assert.equal(options.data.generationConfig.responseMimeType, 'application/json');
      assert.equal(options.data.generationConfig.responseSchema.type, 'OBJECT');
      assert.equal(options.data.generationConfig.maxOutputTokens, 200);
      assert.equal(options.timeout, 15000);
      const sent = JSON.stringify(options.data);
      assert.doesNotMatch(sent, /本名|大分市実在町|0971234567|090-1234-5678/);
      assert.doesNotMatch(sent, /apiKey|key=/);
    })
  });
  assert.deepEqual(result, {
    decision: 'customer', reason: '外壁塗装の見積依頼', model: MODEL
  });
});

test('token preflight bounds input and fails closed without generation', async () => {
  const input = buildInput('survey', { message: '塗装の相談' });
  for (const totalTokens of [5000, 5001, undefined, null]) {
    const calls = [];
    const auth = { getClient: async () => ({ request: async options => {
      calls.push(options);
      if (options.url.endsWith(':countTokens'))
        return { data: { totalTokens } };
      return { data: { candidates: [{
        finishReason: 'STOP', content: { parts: [{ text: '{"decision":"customer","reason":"相談"}' }] }
      }] } };
    } }) };
    if (totalTokens === 5000) {
      assert.equal((await classifyWithGemini(input, { auth })).decision, 'customer');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].timeout, 5000);
      assert.deepEqual(calls[0].data.contents, calls[1].data.contents);
      assert.deepEqual(calls[0].data.systemInstruction, calls[1].data.systemInstruction);
    } else {
      await assert.rejects(classifyWithGemini(input, { auth }), /Input token limit/);
      assert.equal(calls.length, 1);
    }
  }
});
test('fictional customer, sales and ambiguous samples pass through Gemini contract', async () => {
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
    const output = await classifyWithGemini(input, {
      auth: fakeAuth({ decision: expected, reason: '架空データのテスト' })
    });
    assert.equal(output.decision, expected);
  }
});

test('Gemini errors and unfinished responses fail closed', async () => {
  const input = buildInput('survey', { message: '見積もり希望' });
  await assert.rejects(classifyWithGemini(input, {
    auth: { getClient: async () => ({ request: async () => {
      throw new Error('API unavailable');
    } }) }
  }), /API unavailable/);
  await assert.rejects(classifyWithGemini(input, {
    auth: { getClient: async () => ({ request: async options => ({
      data: options.url.endsWith(':countTokens') ? { totalTokens: 100 } :
        { candidates: [{ finishReason: 'MAX_TOKENS' }] }
    }) }) }
  }), /Incomplete/);
});
function database(original) {
  const results = new Map();
  const usage = new Map();
  return {
    results, usage,
    async runTransaction(work) {
      const staged = [];
      const answer = await work({
        get: async ref => ({ exists: usage.has(ref.id), data: () => usage.get(ref.id) }),
        set: (ref, value) => staged.push([ref.id, value])
      });
      for (const [id, value] of staged) usage.set(id, value);
      return answer;
    },
    collection(name) {
      if (name === 'form_ai_daily_usage') return { doc(id) { return { id }; } };
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
test('text and work counts are capped before sending to Gemini', () => {
  const input = buildInput('other', {
    detail: '塗'.repeat(2000), source: 'meishi',
    works: Array(20).fill('屋'.repeat(100))
  });
  assert.equal(input.text.length, 600);
  assert.equal(input.works.length, 10);
  assert.equal(input.works[0].length, 32);
  assert.equal(AI_DAILY_LIMIT, 10);
  assert.equal(AI_MAX_INPUT_TOKENS, 5000);
});

test('daily budget admits at most the configured number of attempts and fails closed', async () => {
  const db = database({ message: '塗装の相談', source: 'meishi' });
  const fixedNow = () => new Date('2026-09-26T15:30:00.000Z');
  let calls = 0;
  const deps = {
    classifier: async () => {
      calls++;
      return { decision: 'customer', reason: '工事相談', model: MODEL };
    },
    now: fixedNow, dailyLimit: 2, serverTimestamp: () => 'unit-time'
  };
  for (let index = 0; index < 3; index++) {
    await processJob(db, 'submissions_d' + index, {
      collection: 'submissions', submissionId: 'd' + index, receivedDay: '2026-09-27'
    }, deps);
  }
  assert.equal(calls, 2);
  assert.equal(db.usage.get('2026-09-27').count, 2);
  assert.equal(db.results.get('submissions_d2').decision, 'unknown');
  assert.equal(db.results.get('submissions_d2').reason, '本日のAI判定上限に達しました');
  const failDb = database({ message: '工事を相談したい' });
  failDb.runTransaction = async () => { throw new Error('Firestore unavailable'); };
  await processJob(failDb, 'submissions_fail', {
    collection: 'submissions', submissionId: 'fail', receivedDay: '2026-09-27'
  }, deps);
  assert.equal(calls, 2);
  assert.equal(failDb.results.get('submissions_fail').reason, 'AI判定の利用上限を確認できません');
});