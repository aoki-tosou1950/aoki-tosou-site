# Sales OS media label lookup (deployment pending)

Read the existing Sales OS "媒体コードマスタ" sheet with the existing
read-only service account in the Sales OS project. The HTTP response includes
only active "fromコード" and "表示名" pairs. This service must be deployed to
Cloud Run with authentication REQUIRED. Its IAM invoker permission must be
granted only to the two form functions' runtime service account.

Configuration on that private service:
- \`SPREADSHEET_ID\`: current Sales OS spreadsheet ID (environment value, never
  commit it).
- Runtime identity: the existing Sales OS read-only service account that
  already has reader access to the workbook; no service account key.
- OAuth scope: \`spreadsheets.readonly\`. It reads only columns B, C, H of
  the master sheet; code sends just B and H in the response.
- No public invoker binding. The Google Cloud platform verifies the ID token.

Configuration on the existing Firebase form functions:
- \`MEDIA_LABELS_URL\`: the Cloud Run service's HTTPS origin.
- The Firebase runtime service account gets \`roles/run.invoker\` on ONLY
  this service, not any Sales OS workbook permission.
- Both submit functions fetch at most once per warm instance per 15 minutes.
  Total lookup deadline is 700ms. A 60-second failure cooldown suppresses
  repeated unavailable lookups. Any error uses the raw source code and
  still sends LINE. Absent source remains "直接・不明".
- There is no second media-name mapping: add a flyer version only once in
  "媒体コードマスタ". New names reach LINE after cache expiry.

Deployment requires separate approval. Deploy private service and its
single-service IAM binding first; verify with an authorized ID token and an
unauthorized request. Then set the form functions' URL and deploy only
submitForm and submitOtherInquiry. Do not set an allow-unauthenticated flag.
Rollback the form functions from the previously recorded production commit;
the private lookup service can remain inaccessible to the forms.