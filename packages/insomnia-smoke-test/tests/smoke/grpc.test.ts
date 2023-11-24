import { expect } from '@playwright/test';

import { loadFixture } from '../../playwright/paths';
import { test } from '../../playwright/test';

test.describe('test grpc requests', async () => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');
  let statusTag: any, responseBody: any;

  // import the proto
  test.beforeEach(async ({ app, page }) => {
    statusTag = page.locator('[data-testid="response-status-tag"]:visible');
    responseBody = page.locator('[data-testid="response-pane"] >> [data-testid="CodeEditor"]:visible', {
      has: page.locator('.CodeMirror-activeline'),
    });

    await page.getByRole('button', { name: 'Create in project' }).click();

    const text = await loadFixture('grpc.yaml');
    await app.evaluate(async ({ clipboard }, text) => clipboard.writeText(text), text);

    await page.getByRole('menuitemradio', { name: 'Import' }).click();
    await page.locator('[data-test-id="import-from-clipboard"]').click();
    await page.getByRole('button', { name: 'Scan' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
    await page.getByText('CollectionPreRelease gRPCjust now').click();
  });

  const testCases = [
    {
      name: 'test unary request',
      methodName: 'RouteGuide/GetFeature',
      clickStart: false,
      clickCommit: false,
      clickTab: true,
      expectedStatus: '0 OK',
      expectedBody: 'Berkshire Valley Management Area Trail',
    },

    // shoud update body as
    // {
    //   "lo": {
    //     "latitude":"409146138",
    //     "longitude":"-746188906"
    //   },
    //   "hi": {
    //     "latitude":"409146138",
    //     "longitude":"-746188906"
    //   }
    // }

    // {
    //   name: 'test server side stream',
    //   methodName: 'RouteGuide/ListFeatures',
    //   clickCommit: false,
    //   clickTab: true,
    //   expectedStatus: '0 OK',
    //   expectedBody: 'Berkshire Valley Management Area Trail, Jefferson, NJ, USA',
    // },
    {
      name: 'test client side stream',
      methodName: 'RouteGuide/RecordRoute',
      clickStart: true,
      clickCommit: true,
      clickTab: true,
      expectedStatus: '0 OK',
      expectedBody: 'point_count": 0',
    },
    {
      name: 'test bidirectional stream',
      methodName: 'RouteGuide/RouteChat',
      clickStart: true,
      clickCommit: true,
      clickTab: false,
      expectedStatus: '0 OK',
      expectedBody: '', // TODO: should verify response
    },
  ];

  for (const tc of testCases) {
    test(tc.name, async ({ page }) => {
      // choose request
      await page.getByLabel('Request Collection').getByTestId('UnaryWithOutProtoFile').press('Enter');
      await expect(page.getByRole('button', { name: 'Select Method' })).toBeDisabled();
      await page.getByTestId('button-server-reflection').click();

      // choose method
      await page.getByRole('button', { name: 'Select Method' }).click();
      await page.getByRole('menuitem', { name: tc.methodName }).click();

      // start
      if (tc.clickStart) {
        await page.getByRole('button', { name: 'Start' }).click();
      } else {
        await page.getByRole('button', { name: 'Send' }).click();
      }
      if (tc.clickCommit) {
        await page.getByRole('button', { name: 'Commit' }).click();
      }

      // verify
      if (tc.clickTab) {
        await page.getByRole('tab', { name: 'Response 1' }).click();
      }
      await expect(statusTag).toContainText(tc.expectedStatus);
      if (tc.expectedBody) {
        await expect(responseBody).toContainText(tc.expectedBody);
      }
    });
  }
});
