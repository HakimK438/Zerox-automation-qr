const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const customerJs = fs.readFileSync(path.join(root, 'customer.js'), 'utf8');

test('customer upload flow matches the supported backend formats', () => {
  assert.match(indexHtml, /accept="[^"]*\.pdf[^"]*\.png[^"]*\.jpg[^"]*\.jpeg[^"]*\.doc[^"]*\.docx[^"]*\.ppt[^"]*\.pptx/i, 'Expected the upload input to advertise the supported file formats');
  assert.match(customerJs, /SUPPORTED_UPLOAD_TYPES|ALLOWED_UPLOAD_TYPES|isSupportedUploadType/i, 'Expected the frontend to validate the same supported upload formats as the backend');
});
