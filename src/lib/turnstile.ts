/**
 * Cloudflare Turnstile verification helper for Waritaku CMS.
 */

export const TURNSTILE_SITE_KEY = '0x4AAAAAAABA0M4eYkOfGkeW';

export interface TurnstileVerificationResult {
    success: boolean;
    error?: string;
    errorCodes?: string[];
    challengeTs?: string;
    hostname?: string;
    action?: string;
    cdata?: string;
}

/**
 * Validates a Turnstile token against Cloudflare's Siteverify API.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
export async function verifyTurnstileToken(
    token: string | null | undefined,
    secret: string | null | undefined,
    remoteIp?: string | null
): Promise<TurnstileVerificationResult> {
    if (!token || typeof token !== 'string' || token.trim() === '') {
        return {
            success: false,
            error: 'Security challenge is required. Please check the Turnstile box.',
            errorCodes: ['missing-input-response']
        };
    }

    const trimmedSecret = secret?.trim();

    // If secret is not configured
    if (!trimmedSecret) {
        if (import.meta.env.DEV) {
            console.warn('[Turnstile] TURNSTILE_SECRET is not configured in local environment. Bypassing check in DEV mode.');
            return { success: true };
        }
        return {
            success: false,
            error: 'Turnstile is not properly configured on the server (missing TURNSTILE_SECRET).',
            errorCodes: ['missing-input-secret']
        };
    }

    try {
        const formData = new FormData();
        formData.append('secret', trimmedSecret);
        formData.append('response', token.trim());
        if (remoteIp) {
            formData.append('remoteip', remoteIp);
        }

        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            return {
                success: false,
                error: `Turnstile verification failed with HTTP status ${response.status}.`,
                errorCodes: ['http-error']
            };
        }

        const outcome: any = await response.json();
        if (outcome.success) {
            return {
                success: true,
                challengeTs: outcome.challenge_ts,
                hostname: outcome.hostname,
                action: outcome.action,
                cdata: outcome.cdata
            };
        }

        const errorCodes: string[] = outcome['error-codes'] || [];
        return {
            success: false,
            error: 'Security verification failed. Please try again.',
            errorCodes
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Turnstile verification request failed: ${err.message || 'Unknown network error'}`,
            errorCodes: ['network-error']
        };
    }
}
