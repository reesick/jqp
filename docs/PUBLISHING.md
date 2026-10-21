# Before clicking Publish

The Vercel dashboard queues publish jobs in the shared Supabase Postgres database. It does not publish images itself. The `apps/worker` publisher must be running on the computer that has the post folders, because it reads those files from disk.

## Start the publisher

1. Open a separate PowerShell window. Keep it open while publishing.
2. Go to the project folder and start the worker:

   ```powershell
   Set-Location D:\jqp
   npm run dev:worker
   ```

3. Wait for `worker_ready` in the output. If the command exits or shows an error, do not click Publish; copy the error and investigate first.
4. Confirm the root `.env` used by this worker is configured for the same production Supabase database as the dashboard, and that `MOCK_META` is `false`. Never paste `.env` values into chat.
5. In the dashboard, check that the intended post and Instagram account are correct, then click **Publish** once. Leave the worker window open. The post detail page should move through the publishing steps and eventually show `PUBLISHED`.
6. When finished, stop the worker with **Ctrl+C**.

## Important when restarting after earlier clicks

Starting the worker makes it consume jobs that are already waiting in Supabase. It may start publishing a post immediately, without another dashboard click. If you previously clicked Publish and do not want that post to go live yet, do not start the worker until you have checked the intended post and are ready for it to publish.

Repeated clicks are not a reliable way to check whether a request worked. The API can return success when a job is already queued, and the post can remain `DISCOVERED` until the worker starts processing it. The Posts page does not show a separate publish-queue list.

## If the status does not move

- Check that the worker window still shows `worker_ready` and has no connection or startup errors.
- Refresh the post detail page after a short wait. The worker logs should show it starting the publish pipeline for that post.
- If the worker is running but the status stays `DISCOVERED`, do not keep clicking Publish. Save the worker output and the browser Network response for the publish request, then investigate the queue state before retrying.

This is the **publishing** worker. The DM worker on the Oracle VM is a different process and does not publish posts.
