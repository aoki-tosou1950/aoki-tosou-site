'use strict';

// Read-only: retrieve only fields required for classification; never write records.
const { execSync } = require('node:child_process');
const axios = require('axios');
const { buildInput, classifyWithGemini } = require('../lib/form-ai');
const PROJECT = 'aokitosou-miniapp';
const FIELDS = ['source', 'test_event', 'message', 'detail', 'works', 'createdAt'];
const legacyTestSources = new Set(['production_smoke', 'production_smoke_hardening']);

function value(field) {
  if (!field) return undefined;
  if (Object.hasOwn(field, 'stringValue')) return field.stringValue;
  if (Object.hasOwn(field, 'booleanValue')) return field.booleanValue;
  if (field.arrayValue) return (field.arrayValue.values || []).map(value);
  if (field.timestampValue) return field.timestampValue;
  return undefined;
}

async function records(collection, accessToken) {
  const all = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '100' });
    for (const field of FIELDS) query.append('mask.fieldPaths', field);
    if (pageToken) query.set('pageToken', pageToken);
    const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT +
      '/databases/(default)/documents/' + collection + '?' + query.toString();
    const result = await axios.get(url, {
      headers: { Authorization: 'Bearer ' + accessToken }, timeout: 15000
    });
    all.push(...(result.data.documents || []));
    pageToken = result.data.nextPageToken || '';
  } while (pageToken);
  return all;
}

async function main() {


  const accessToken = execSync('gcloud auth print-access-token', {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  const auth = { getClient: async () => ({
    request: ({ url, method, data, timeout }) => axios({
      url, method, data, timeout,
      headers: { Authorization: 'Bearer ' + accessToken }
    })
  }) };
  let counted = 0;
  for (const collection of ['submissions', 'other_inquiries']) {
    const docs = await records(collection, accessToken);
    for (const doc of docs) {
      const f = doc.fields || {};
      const source = value(f.source) || '';
      if (value(f.test_event) === true || legacyTestSources.has(source)) continue;
      const data = {
        source, message: value(f.message) || '', detail: value(f.detail) || '',
        works: value(f.works) || []
      };
      const input = buildInput(collection === 'submissions' ? 'survey' : 'other', data);
      let result;
      try {
        result = await classifyWithGemini(input, { auth });
      } catch (error) {
        throw new Error('Gemini trial stopped (record ' + (counted + 1) +
          ', HTTP ' + (error.response?.status || 'unavailable') +
          '); no classification was written');
      }
      counted++;
      process.stdout.write(JSON.stringify({
        record: counted, form: input.formType, day: (doc.createTime || '').slice(0, 10),
        source: input.source, decision: result.decision, reason: result.reason,
        model: result.model
      }) + '\n');
    }
  }
  process.stdout.write('Read-only classifications: ' + counted + '\n');
}
main().catch(error => {
  process.stderr.write(String(error.message || error) + '\n');
  process.exitCode = 1;
});