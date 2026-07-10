import {
  Kind,
  parse,
  type ArgumentNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql'

import {
  CMS_REPOSITORY,
  isAllowedCmsWritePath,
  normalizeCmsPath,
  sanitizeCmsBranchPart,
} from './_cms-policy.ts'
import {
  GitHubApiError,
  copyGitHubResponse,
  fetchCmsTree,
  getAllowedCmsBlobShas,
  githubJson,
  githubRequest,
  isRecord,
} from './_github-api.ts'

type Env = {
  CMS_ACCESS_ALLOWED_EMAILS?: string
  CMS_ACCESS_ALLOWED_DOMAINS?: string
  CMS_ACCESS_HOSTNAMES?: string
  CMS_GITHUB_TOKEN?: string
}

type GraphqlPayload = {
  query: string
  variables: Record<string, unknown>
}

type CmsAddition = {
  path: string
  contents: string
  byteSize: number
}

type CmsDeletion = {
  path: string
}

type CmsCommitInput = {
  expectedHeadOid: string
  additions: CmsAddition[]
  deletions: CmsDeletion[]
}

const DEFAULT_ACCESS_HOSTNAMES = [
  'hatt.acecore.net',
  'www.hatt.acecore.net',
  'homepage-hatt.pages.dev',
  '*.homepage-hatt.pages.dev',
  'localhost',
  '127.0.0.1',
]

const SHA_PATTERN = /^[a-f0-9]{40}$/i
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_GRAPHQL_QUERY_CHARS = 512 * 1024
const MAX_REQUEST_CHARS = 36 * 1024 * 1024
const MAX_CHANGE_COUNT = 100
const MAX_TOTAL_CONTENT_BYTES = 25 * 1024 * 1024
const MAX_GRAPHQL_BLOB_SIZE = 10 * 1024 * 1024

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  const token = env.CMS_GITHUB_TOKEN?.trim()

  if (!token) {
    return json(
      { message: 'CMS_GITHUB_TOKEN がCloudflare Pagesに設定されていません。' },
      503,
    )
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0)

  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_CHARS) {
    return json({ message: 'CMS保存データが大きすぎます。' }, 413)
  }

  try {
    const bodyText = await request.text()

    if (bodyText.length > MAX_REQUEST_CHARS) {
      return json({ message: 'CMS保存データが大きすぎます。' }, 413)
    }

    const payload = parseGraphqlPayload(bodyText)

    if (!payload || payload.query.length > MAX_GRAPHQL_QUERY_CHARS) {
      return json({ message: 'CMS GraphQL request が不正です。' }, 400)
    }

    const operation = parseOperation(payload.query)

    if (!operation) {
      return json({ message: 'CMS GraphQL operation が不正です。' }, 400)
    }

    if (operation.operation === 'query') {
      return await handleReadQuery({ operation, payload, token })
    }

    if (operation.operation === 'mutation') {
      return await handleCommitMutation({ auth, operation, payload, token })
    }

    return json(
      { message: 'CMS GraphQL operation は許可されていません。' },
      403,
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

async function handleReadQuery({
  operation,
  payload,
  token,
}: {
  operation: OperationDefinitionNode
  payload: GraphqlPayload
  token: string
}) {
  const authorization = validateReadOperation(operation, payload.variables)

  if (!authorization) {
    return json({ message: 'CMSで許可されていないGraphQL queryです。' }, 403)
  }

  if (authorization.blobShas.size > 0) {
    const tree = await fetchCmsTree(token)
    const allowedShas = getAllowedCmsBlobShas(tree)

    if (
      Array.from(authorization.blobShas).some((sha) => !allowedShas.has(sha))
    ) {
      return json({ message: 'CMS管理対象外のGit blobです。' }, 403)
    }
  }

  const response = await githubRequest({
    body: {
      query: payload.query,
      variables: payload.variables,
    },
    method: 'POST',
    path: '/graphql',
    token,
  })

  return copyGitHubResponse(response)
}

async function handleCommitMutation({
  auth,
  operation,
  payload,
  token,
}: {
  auth: { email: string }
  operation: OperationDefinitionNode
  payload: GraphqlPayload
  token: string
}) {
  if (!isCmsCommitOperation(operation, payload.variables)) {
    return json({ message: 'CMSで許可されていないGraphQL mutationです。' }, 403)
  }

  const commitInput = parseCmsCommitInput(payload.variables.input)

  if (!commitInput) {
    return json(
      { message: 'CMS管理対象外のファイル、または不正な保存データです。' },
      403,
    )
  }

  const mainRef = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/ref/heads/${CMS_REPOSITORY.branch}`,
    token,
  })
  const mainSha = getGitRefSha(mainRef)

  if (!mainSha) {
    throw new GitHubApiError('GitHub branch response が不正です。', 502)
  }

  if (mainSha !== commitInput.expectedHeadOid) {
    return json(
      {
        message:
          'mainが更新されています。CMSを再読み込みしてから、もう一度保存してください。',
      },
      409,
    )
  }

  const changedPaths = [
    ...commitInput.additions.map(({ path }) => path),
    ...commitInput.deletions.map(({ path }) => path),
  ]
  const branch = await createCmsBranch({
    baseSha: mainSha,
    primaryPath: changedPaths[0],
    token,
  })
  const mutation = buildCmsCommitMutation(commitInput.additions)
  let githubResult: Record<string, unknown>

  try {
    githubResult = await githubJson<Record<string, unknown>>({
      body: {
        query: mutation,
        variables: {
          input: {
            branch: {
              repositoryNameWithOwner: `${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`,
              branchName: branch,
            },
            expectedHeadOid: mainSha,
            fileChanges: {
              additions: commitInput.additions.map(({ path, contents }) => ({
                path,
                contents,
              })),
              deletions: commitInput.deletions,
            },
            message: {
              headline: buildCommitHeadline(changedPaths),
            },
          },
        },
      },
      method: 'POST',
      path: '/graphql',
      token,
    })

    ensureCommitSucceeded(githubResult)
  } catch (error) {
    if (error instanceof GitHubApiError) {
      await deleteUncommittedCmsBranch(branch, token)
    }

    throw error
  }

  const pullRequest = await openPullRequest({
    branch,
    changedPaths,
    email: auth.email,
    token,
  })
  const extensions = isRecord(githubResult.extensions)
    ? githubResult.extensions
    : {}

  return json({
    ...githubResult,
    extensions: {
      ...extensions,
      cms: {
        branch,
        pull_request: {
          number: pullRequest.number,
          html_url: pullRequest.html_url,
        },
      },
    },
  })
}

function validateReadOperation(
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
) {
  if (
    operation.operation !== 'query' ||
    operation.directives?.length ||
    !variablesMatchDefinitions(operation, variables) ||
    operation.selectionSet.selections.length !== 1
  ) {
    return null
  }

  const root = operation.selectionSet.selections[0]

  if (
    root.kind !== Kind.FIELD ||
    root.name.value !== 'repository' ||
    root.alias ||
    !root.selectionSet ||
    !hasExactArguments(root, ['owner', 'name']) ||
    !argumentMatches(root, 'owner', CMS_REPOSITORY.owner, variables) ||
    !argumentMatches(root, 'name', CMS_REPOSITORY.name, variables)
  ) {
    return null
  }

  const authorization = { blobShas: new Set<string>() }

  return validateRepositorySelection(
    root.selectionSet,
    variables,
    authorization,
  )
    ? authorization
    : null
}

function validateRepositorySelection(
  selectionSet: SelectionSetNode,
  variables: Record<string, unknown>,
  authorization: { blobShas: Set<string> },
) {
  if (
    selectionSet.selections.length === 0 ||
    selectionSet.selections.length > 600
  ) {
    return false
  }

  return selectionSet.selections.every((selection) => {
    if (selection.kind !== Kind.FIELD || selection.directives?.length)
      return false

    if (selection.name.value === 'defaultBranchRef') {
      return (
        !selection.arguments?.length &&
        !!selection.selectionSet &&
        validateLeafSelection(selection.selectionSet, ['name'])
      )
    }

    if (selection.name.value === 'ref') {
      return (
        !!selection.selectionSet &&
        hasExactArguments(selection, ['qualifiedName']) &&
        argumentMatches(
          selection,
          'qualifiedName',
          CMS_REPOSITORY.branch,
          variables,
        ) &&
        validateRefSelection(selection.selectionSet)
      )
    }

    if (selection.name.value === 'object') {
      const oid = getArgumentString(selection, 'oid', variables)

      if (
        !oid ||
        !SHA_PATTERN.test(oid) ||
        !selection.selectionSet ||
        !hasExactArguments(selection, ['oid']) ||
        !validateBlobObjectSelection(selection.selectionSet)
      ) {
        return false
      }

      authorization.blobShas.add(oid)
      return true
    }

    return false
  })
}

function validateRefSelection(selectionSet: SelectionSetNode) {
  if (selectionSet.selections.length !== 1) return false

  const target = selectionSet.selections[0]

  return (
    target.kind === Kind.FIELD &&
    target.name.value === 'target' &&
    !target.alias &&
    !target.arguments?.length &&
    !target.directives?.length &&
    !!target.selectionSet &&
    validateTypedSelection(
      target.selectionSet,
      'Commit',
      validateCommitSelection,
    )
  )
}

function validateBlobObjectSelection(selectionSet: SelectionSetNode) {
  return validateTypedSelection(selectionSet, 'Blob', (blobSelection) => {
    return validateLeafSelection(blobSelection, ['text'])
  })
}

function validateTypedSelection(
  selectionSet: SelectionSetNode,
  typeName: string,
  validator: (selectionSet: SelectionSetNode) => boolean,
) {
  if (selectionSet.selections.length !== 1) return false

  const fragment = selectionSet.selections[0]

  return (
    fragment.kind === Kind.INLINE_FRAGMENT &&
    fragment.typeCondition?.name.value === typeName &&
    !fragment.directives?.length &&
    validator(fragment.selectionSet)
  )
}

function validateCommitSelection(selectionSet: SelectionSetNode) {
  if (
    selectionSet.selections.length === 0 ||
    selectionSet.selections.length > 300
  ) {
    return false
  }

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.name.value !== 'history' ||
      selection.directives?.length ||
      !selection.selectionSet
    ) {
      return false
    }

    const argumentNames = (selection.arguments || []).map(
      ({ name }) => name.value,
    )

    if (
      !argumentNames.includes('first') ||
      argumentNames.some((name) => name !== 'first' && name !== 'path') ||
      new Set(argumentNames).size !== argumentNames.length
    ) {
      return false
    }

    const first = getArgument(selection, 'first')?.value

    if (first?.kind !== Kind.INT) return false

    const firstValue = Number(first.value)

    if (!Number.isInteger(firstValue) || firstValue < 1 || firstValue > 100) {
      return false
    }

    const pathArgument = getArgument(selection, 'path')

    if (pathArgument) {
      if (pathArgument.value.kind !== Kind.STRING) return false

      const path = normalizeCmsPath(pathArgument.value.value)

      if (
        !path ||
        path !== pathArgument.value.value ||
        !isAllowedCmsWritePath(path)
      ) {
        return false
      }
    }

    return validateHistorySelection(selection.selectionSet)
  })
}

function validateHistorySelection(selectionSet: SelectionSetNode) {
  if (selectionSet.selections.length !== 1) return false

  const nodes = selectionSet.selections[0]

  return (
    nodes.kind === Kind.FIELD &&
    nodes.name.value === 'nodes' &&
    !nodes.alias &&
    !nodes.arguments?.length &&
    !nodes.directives?.length &&
    !!nodes.selectionSet &&
    validateCommitNodeSelection(nodes.selectionSet)
  )
}

function validateCommitNodeSelection(selectionSet: SelectionSetNode) {
  const leafFields = new Set(['oid', 'message', 'committedDate'])

  if (selectionSet.selections.length === 0) return false

  return selectionSet.selections.every((selection) => {
    if (selection.kind !== Kind.FIELD || selection.directives?.length)
      return false

    if (leafFields.has(selection.name.value)) {
      return !selection.arguments?.length && !selection.selectionSet
    }

    if (selection.name.value !== 'author') return false

    return (
      !selection.arguments?.length &&
      !!selection.selectionSet &&
      validateAuthorSelection(selection.selectionSet)
    )
  })
}

function validateAuthorSelection(selectionSet: SelectionSetNode) {
  const leafFields = new Set(['name', 'email', 'avatarUrl'])

  if (selectionSet.selections.length === 0) return false

  return selectionSet.selections.every((selection) => {
    if (selection.kind !== Kind.FIELD || selection.directives?.length)
      return false

    if (leafFields.has(selection.name.value)) {
      return !selection.arguments?.length && !selection.selectionSet
    }

    if (selection.name.value !== 'user') return false

    return (
      !selection.arguments?.length &&
      !!selection.selectionSet &&
      validateLeafSelection(selection.selectionSet, ['databaseId', 'login'])
    )
  })
}

function validateLeafSelection(
  selectionSet: SelectionSetNode,
  allowedNames: string[],
) {
  const allowed = new Set(allowedNames)

  return (
    selectionSet.selections.length > 0 &&
    selectionSet.selections.every((selection) => {
      return (
        selection.kind === Kind.FIELD &&
        allowed.has(selection.name.value) &&
        !selection.arguments?.length &&
        !selection.directives?.length &&
        !selection.selectionSet
      )
    })
  )
}

function isCmsCommitOperation(
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
) {
  if (
    operation.operation !== 'mutation' ||
    operation.directives?.length ||
    operation.selectionSet.selections.length !== 1 ||
    Object.keys(variables).length !== 1 ||
    !Object.hasOwn(variables, 'input')
  ) {
    return false
  }

  const root = operation.selectionSet.selections[0]

  if (
    root.kind !== Kind.FIELD ||
    root.name.value !== 'createCommitOnBranch' ||
    root.alias ||
    root.directives?.length ||
    !root.selectionSet ||
    !hasExactArguments(root, ['input'])
  ) {
    return false
  }

  const input = getArgument(root, 'input')?.value

  return input?.kind === Kind.VARIABLE && input.name.value === 'input'
}

function parseCmsCommitInput(value: unknown): CmsCommitInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'branch',
      'expectedHeadOid',
      'fileChanges',
      'message',
    ]) ||
    !isRecord(value.branch) ||
    !hasOnlyKeys(value.branch, ['repositoryNameWithOwner', 'branchName']) ||
    value.branch.repositoryNameWithOwner !==
      `${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}` ||
    value.branch.branchName !== CMS_REPOSITORY.branch ||
    typeof value.expectedHeadOid !== 'string' ||
    !SHA_PATTERN.test(value.expectedHeadOid) ||
    !isRecord(value.fileChanges) ||
    !hasOnlyKeys(value.fileChanges, ['additions', 'deletions']) ||
    !isRecord(value.message) ||
    !hasOnlyKeys(value.message, ['headline']) ||
    typeof value.message.headline !== 'string'
  ) {
    return null
  }

  const additionsValue = value.fileChanges.additions ?? []
  const deletionsValue = value.fileChanges.deletions ?? []

  if (!Array.isArray(additionsValue) || !Array.isArray(deletionsValue)) {
    return null
  }

  if (
    additionsValue.length + deletionsValue.length === 0 ||
    additionsValue.length + deletionsValue.length > MAX_CHANGE_COUNT
  ) {
    return null
  }

  const additions: CmsAddition[] = []
  const deletions: CmsDeletion[] = []
  const paths = new Set<string>()
  let totalContentBytes = 0

  for (const addition of additionsValue) {
    if (
      !isRecord(addition) ||
      !hasOnlyKeys(addition, ['path', 'contents']) ||
      typeof addition.path !== 'string' ||
      typeof addition.contents !== 'string' ||
      !BASE64_PATTERN.test(addition.contents)
    ) {
      return null
    }

    const path = normalizeCmsPath(addition.path)

    if (
      !path ||
      path !== addition.path ||
      !isAllowedCmsWritePath(path) ||
      paths.has(path)
    ) {
      return null
    }

    const byteSize = getBase64ByteSize(addition.contents)

    totalContentBytes += byteSize

    if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) return null

    paths.add(path)
    additions.push({ path, contents: addition.contents, byteSize })
  }

  for (const deletion of deletionsValue) {
    if (
      !isRecord(deletion) ||
      !hasOnlyKeys(deletion, ['path']) ||
      typeof deletion.path !== 'string'
    ) {
      return null
    }

    const path = normalizeCmsPath(deletion.path)

    if (
      !path ||
      path !== deletion.path ||
      !isAllowedCmsWritePath(path) ||
      paths.has(path)
    ) {
      return null
    }

    paths.add(path)
    deletions.push({ path })
  }

  return {
    expectedHeadOid: value.expectedHeadOid,
    additions,
    deletions,
  }
}

async function createCmsBranch({
  baseSha,
  primaryPath,
  token,
}: {
  baseSha: string
  primaryPath: string
  token: string
}) {
  const base = sanitizeCmsBranchPart(primaryPath)

  for (let index = 0; index < 3; index += 1) {
    const id = crypto.randomUUID().slice(0, 8)
    const branch = `cms/hatt/${timestamp()}-${base}-${id}`

    try {
      await githubJson({
        body: {
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        },
        method: 'POST',
        path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/refs`,
        token,
      })

      return branch
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) {
        throw error
      }
    }
  }

  throw new GitHubApiError('CMS保存用branchを作成できませんでした。', 409)
}

async function deleteUncommittedCmsBranch(branch: string, token: string) {
  try {
    const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')
    const response = await githubRequest({
      method: 'DELETE',
      path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/refs/heads/${encodedBranch}`,
      token,
    })

    if (!response.ok && response.status !== 404) {
      console.error(
        JSON.stringify({
          message: 'Failed to remove unused CMS branch',
          branch,
          status: response.status,
        }),
      )
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Failed to remove unused CMS branch',
        branch,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

async function openPullRequest({
  branch,
  changedPaths,
  email,
  token,
}: {
  branch: string
  changedPaths: string[]
  email: string
  token: string
}) {
  const primaryPath = summarizePath(changedPaths[0])
  const extraCount = changedPaths.length - 1
  const title = `cms: update ${primaryPath}${extraCount > 0 ? ` (+${extraCount})` : ''}`

  const result = await githubJson<unknown>({
    body: {
      base: CMS_REPOSITORY.branch,
      body: [
        'Sveltia CMS の保存を Cloudflare Access 認証済みユーザーから受け付けました。',
        '',
        `- Access user: ${email}`,
        '- Files:',
        ...changedPaths.map((path) => `  - \`${path}\``),
        '',
        '画像とコンテンツは同じ commit に含まれています。',
        'CIで content/schema/build を確認してから main に取り込んでください。',
      ].join('\n'),
      head: branch,
      title,
    },
    method: 'POST',
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/pulls`,
    token,
  })

  if (
    !isRecord(result) ||
    typeof result.number !== 'number' ||
    typeof result.html_url !== 'string'
  ) {
    throw new GitHubApiError('GitHub pull request response が不正です。', 502)
  }

  return { number: result.number, html_url: result.html_url }
}

function buildCmsCommitMutation(additions: CmsAddition[]) {
  const fileShaQuery = additions
    .map(({ path, byteSize }, index) => {
      return byteSize <= MAX_GRAPHQL_BLOB_SIZE
        ? `file_${index}: file(path: ${JSON.stringify(path)}) { oid }`
        : ''
    })
    .filter(Boolean)
    .join('\n')

  return `
    mutation CmsCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          committedDate
          ${fileShaQuery}
        }
      }
    }
  `
}

function ensureCommitSucceeded(result: Record<string, unknown>) {
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const firstError = result.errors[0]
    const message =
      isRecord(firstError) && typeof firstError.message === 'string'
        ? firstError.message
        : 'GitHub GraphQL mutation が失敗しました。'

    throw new GitHubApiError(message, 502)
  }

  if (
    !isRecord(result.data) ||
    !isRecord(result.data.createCommitOnBranch) ||
    !isRecord(result.data.createCommitOnBranch.commit) ||
    typeof result.data.createCommitOnBranch.commit.oid !== 'string'
  ) {
    throw new GitHubApiError(
      'GitHub GraphQL mutation response が不正です。',
      502,
    )
  }
}

function parseGraphqlPayload(text: string): GraphqlPayload | null {
  try {
    const value: unknown = JSON.parse(text)

    if (
      !isRecord(value) ||
      typeof value.query !== 'string' ||
      (value.variables !== undefined && !isRecord(value.variables))
    ) {
      return null
    }

    return {
      query: value.query,
      variables: value.variables || {},
    }
  } catch {
    return null
  }
}

function parseOperation(query: string) {
  try {
    const document = parse(query)

    if (document.definitions.length !== 1) return null

    const definition = document.definitions[0]

    return definition.kind === Kind.OPERATION_DEFINITION ? definition : null
  } catch {
    return null
  }
}

function variablesMatchDefinitions(
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
) {
  const defined = new Set(
    (operation.variableDefinitions || []).map(
      ({ variable }) => variable.name.value,
    ),
  )

  return Object.keys(variables).every((name) => defined.has(name))
}

function hasExactArguments(field: FieldNode, names: string[]) {
  const argumentsList = field.arguments || []

  return (
    argumentsList.length === names.length &&
    new Set(argumentsList.map(({ name }) => name.value)).size ===
      names.length &&
    names.every((name) => argumentsList.some((arg) => arg.name.value === name))
  )
}

function argumentMatches(
  field: FieldNode,
  name: string,
  expected: string,
  variables: Record<string, unknown>,
) {
  return getArgumentString(field, name, variables) === expected
}

function getArgument(field: FieldNode, name: string): ArgumentNode | undefined {
  return field.arguments?.find((argument) => argument.name.value === name)
}

function getArgumentString(
  field: FieldNode,
  name: string,
  variables: Record<string, unknown>,
) {
  const value = getArgument(field, name)?.value

  return value ? resolveStringValue(value, variables) : null
}

function resolveStringValue(
  value: ValueNode,
  variables: Record<string, unknown>,
) {
  if (value.kind === Kind.STRING) return value.value

  if (value.kind === Kind.VARIABLE) {
    const variable = variables[value.name.value]

    return typeof variable === 'string' ? variable : null
  }

  return null
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]) {
  const allowed = new Set(allowedKeys)

  return Object.keys(value).every((key) => allowed.has(key))
}

function getBase64ByteSize(value: string) {
  if (!value) return 0

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0

  return (value.length * 3) / 4 - padding
}

function buildCommitHeadline(changedPaths: string[]) {
  const extraCount = changedPaths.length - 1

  return `cms: update ${summarizePath(changedPaths[0])}${extraCount > 0 ? ` (+${extraCount})` : ''}`
}

function summarizePath(path: string) {
  return path.length > 200 ? `${path.slice(0, 197)}...` : path
}

function getGitRefSha(value: unknown) {
  if (!isRecord(value) || !isRecord(value.object)) return null

  return typeof value.object.sha === 'string' &&
    SHA_PATTERN.test(value.object.sha)
    ? value.object.sha
    : null
}

function timestamp() {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14)
}

function getAccessIdentity(request: Request, env: Env) {
  const hostname = new URL(request.url).hostname.toLowerCase()

  if (!isAllowedAccessHostname(hostname, env)) {
    return {
      ok: false as const,
      status: 401,
      message:
        'Cloudflare Accessで保護されたCMSドメインからログインしてください。',
    }
  }

  const headerEmail =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('Cf-Access-Authenticated-User-Email') ||
    ''
  const jwt =
    request.headers.get('cf-access-jwt-assertion') ||
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    ''
  const email = headerEmail || getAccessJwtEmail(jwt)

  if (!email && !jwt) {
    return {
      ok: false as const,
      status: 401,
      message: 'Cloudflare Accessでログインしてください。',
    }
  }

  if (!email) {
    return {
      ok: false as const,
      status: 403,
      message: 'Cloudflare Accessのメールを確認できません。',
    }
  }

  if (!isAllowedAccessEmail(email, env)) {
    return {
      ok: false as const,
      status: 403,
      message: 'CMS編集が許可されていないCloudflare Accessユーザーです。',
    }
  }

  return { ok: true as const, email }
}

function isAllowedAccessHostname(hostname: string, env: Env) {
  return [...DEFAULT_ACCESS_HOSTNAMES, ...parseCsv(env.CMS_ACCESS_HOSTNAMES)]
    .filter(Boolean)
    .some((pattern) => hostnameMatches(pattern, hostname))
}

function isAllowedAccessEmail(email: string, env: Env) {
  const allowed = parseCsv(env.CMS_ACCESS_ALLOWED_EMAILS)
  const allowedDomains = parseCsv(env.CMS_ACCESS_ALLOWED_DOMAINS)
  const normalizedEmail = email.toLowerCase()
  const domain = normalizedEmail.split('@').pop() || ''

  return allowed.includes(normalizedEmail) || allowedDomains.includes(domain)
}

function getAccessJwtEmail(jwt: string) {
  if (!jwt) return ''

  const payload = jwt.split('.')[1]

  if (!payload) return ''

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data: unknown = JSON.parse(atob(padded))
    const email = isRecord(data) ? data.email : null

    return typeof email === 'string' ? email : ''
  } catch {
    return ''
  }
}

function parseCsv(value: string | undefined) {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function hostnameMatches(pattern: string, hostname: string) {
  const normalizedPattern = pattern.trim().toLowerCase()

  if (normalizedPattern.startsWith('*.')) {
    return hostname.endsWith(normalizedPattern.slice(1))
  }

  return hostname === normalizedPattern
}

function toErrorResponse(error: unknown) {
  if (error instanceof GitHubApiError) {
    return json({ message: error.message }, error.status)
  }

  console.error(
    JSON.stringify({
      message: 'CMS GraphQL proxy failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return json({ message: 'CMS GraphQL proxyでエラーが発生しました。' }, 500)
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}
