import { createRemoteJWKSet, jwtVerify } from 'jose'

import { CMS_REPOSITORY } from '../_cms-policy.ts'
import { CmsAiError, getRunnerAudience, type CmsAiEnv } from './_shared.ts'

const DEFAULT_ISSUER = 'https://token.actions.githubusercontent.com'
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export type GitHubActionsIdentity = {
  repository: string
  runId: string | null
  workflow: string | null
}

export async function getGitHubActionsIdentity(
  request: Request,
  env: CmsAiEnv,
): Promise<GitHubActionsIdentity> {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.replace(/^Bearer\s+/i, '')

  if (!token || token === authorization) {
    throw new CmsAiError(401, 'GitHub Actionsの認証が必要です。')
  }

  const issuer = getIssuer(env)
  let payload

  try {
    const verified = await jwtVerify(token, getJwks(issuer), {
      algorithms: ['RS256'],
      audience: getRunnerAudience(env),
      issuer,
    })
    payload = verified.payload
  } catch {
    throw new CmsAiError(401, 'GitHub Actionsの認証を確認できません。')
  }

  const repository = String(payload.repository || '')
  const expectedRepository = CMS_REPOSITORY.owner + '/' + CMS_REPOSITORY.name

  if (
    repository !== expectedRepository ||
    payload.event_name !== 'repository_dispatch' ||
    payload.ref !== 'refs/heads/' + CMS_REPOSITORY.branch
  ) {
    throw new CmsAiError(403, 'このGitHub Actions実行は許可されていません。')
  }

  return {
    repository,
    runId: typeof payload.run_id === 'string' ? payload.run_id : null,
    workflow: typeof payload.workflow === 'string' ? payload.workflow : null,
  }
}

function getIssuer(env: CmsAiEnv) {
  const configured = String(env.CMS_AI_GITHUB_OIDC_ISSUER || '').trim()

  if (!configured) return DEFAULT_ISSUER

  try {
    const url = new URL(configured)

    return url.protocol === 'https:' && !url.username && !url.password
      ? url.origin
      : DEFAULT_ISSUER
  } catch {
    return DEFAULT_ISSUER
  }
}

function getJwks(issuer: string) {
  let jwks = jwksByIssuer.get(issuer)

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('/.well-known/jwks', issuer + '/'))
    jwksByIssuer.set(issuer, jwks)
  }

  return jwks
}
