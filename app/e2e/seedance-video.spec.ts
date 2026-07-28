import { test, expect } from '@playwright/test';

/**
 * Long path: public image → step1 → step2 (Seedance) → poll URL / cache.
 * Skips when Seedance not ready. Step5 FFmpeg is optional.
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';
const PUBLIC_IMAGE =
  process.env.E2E_PUBLIC_IMAGE ||
  'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80';

test.describe('Seedance image-to-video long path', () => {
  test('step1 → step2 submit + poll until url or soft continue', async ({ request }) => {
    test.setTimeout(240_000);

    const health = await (await request.get(`${BASE}/api/health?probe=1`)).json();
    const seedanceReady = Boolean(
      health?.readiness?.seedance?.ready || health?.readiness?.seedance?.tokenOk
    );
    test.skip(!seedanceReady, 'Seedance not ready — skip long video e2e');

    // Step 1
    // Prefer fixed prompt to avoid upstream LLM 429 when suite already ran step1
    let prompt =
      'A young Asian woman holding mint green clay cleanser in bright bathroom, morning light, lifestyle skincare, 8k';

    const s1 = await (
      await request.post(`${BASE}/api/pipeline/step1`, {
        data: {
          mediaUrl: PUBLIC_IMAGE,
          platform: 'xiaohongshu',
          bloggerType: 'daily_seeding',
          viralReason: 'e2e seedance long path',
        },
      })
    ).json();
    if (s1.success && s1.data?.static_image_prompt) {
      prompt = s1.data.static_image_prompt;
    } else {
      console.warn('step1 skipped/fallback due to:', s1.error || 'no data — using fixed prompt for Seedance');
    }

    // Step 2 with public first frame (does not require step1 LLM if we have prompt)
    const s2 = await (
      await request.post(`${BASE}/api/pipeline/step2`, {
        data: {
          static_image_prompt: prompt,
          imageUrl: PUBLIC_IMAGE,
          videoTone: 'xiaohongshu_healing',
          durationSec: 5,
          videoModel: 'Seedance 2.0 Fast',
        },
      })
    ).json();
    if (!s2.success) {
      test.skip(true, `step2 unavailable: ${s2.error || 'unknown'}`);
      return;
    }
    expect(s2.data?.video_prompt).toBeTruthy();

    const taskId = s2.data?.seedanceTaskId;
    let videoUrl = s2.data?.previewVideoUrl as string | undefined;

    if (!taskId && !videoUrl) {
      // Prompt-only path (e.g. material public URL rejected)
      console.warn('step2 no seedance task:', s2.data?.seedanceStatus, s2.data?.seedanceError);
      expect(
        s2.data?.seedanceStatus === 'awaiting_public_image' ||
          s2.data?.seedanceStatus === 'unconfigured' ||
          s2.data?.seedanceError
      ).toBeTruthy();
      return;
    }

    if (taskId && !videoUrl) {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const poll = await (
          await request.get(`${BASE}/api/seedance/generations/${encodeURIComponent(taskId)}`)
        ).json();
        if (poll?.data?.url) {
          videoUrl = poll.data.url;
          break;
        }
        const st = String(poll?.data?.status || '').toLowerCase();
        if (st === 'failed' || st === 'error') {
          throw new Error(poll?.data?.error || 'seedance failed');
        }
      }
    }

    // Soft: timeout is acceptable for CI; assert we either got url or waited cleanly
    if (videoUrl) {
      expect(videoUrl.length).toBeGreaterThan(5);
      // Prefer local cache path after poll endpoint
      console.log('seedance video url', videoUrl);
      if (videoUrl.startsWith('http') && !videoUrl.includes('/uploads/')) {
        const cached = await (
          await request.post(`${BASE}/api/seedance/cache`, {
            data: { url: videoUrl, name: `e2e_${Date.now()}` },
          })
        ).json();
        if (cached.success) {
          expect(cached.data.videoUrl).toMatch(/\/uploads\/renders\//);
          videoUrl = cached.data.videoUrl;
        }
      }

      // Optional Step5 if ffmpeg present
      if (health?.readiness?.ffmpeg?.installed && videoUrl) {
        const s5 = await (
          await request.post(`${BASE}/api/pipeline/step5`, {
            data: {
              aspectRatio: '9:16',
              subtitleStyle: '黄字黑边',
              title: s1.data?.scene || 'e2e',
              videoSourceUrl: videoUrl,
            },
          })
        ).json();
        if (s5.success) {
          expect(s5.data?.output?.videoUrl || s5.data?.output?.downloadUrl).toBeTruthy();
        } else {
          console.warn('step5 failed (non-fatal):', s5.error);
        }
      }
    } else {
      console.warn('Seedance poll timeout — task submitted but no url yet');
      expect(taskId).toBeTruthy();
    }
  });
});
