import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateProjectedCmsReferences } from '../functions/admin/api/_cms-reference-validator.ts'
import {
  isCmsReferenceStatePath,
  isCmsReferenceTextPath,
} from '../functions/admin/api/_cms-policy.ts'
import { fetchCmsReferenceState } from '../functions/admin/api/_github-api.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const currentState = await readCurrentReferenceState()
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('現行repositoryの全CMS contentと参照先が整合している', async () => {
  await validateProjectedCmsReferences({
    additions: [],
    currentState,
    deletions: [],
  })
})

test('同じ保存でauthor・tag・画像・記事を追加できる', async () => {
  await validateProjectedCmsReferences({
    additions: [
      jsonAddition('src/content/authors/projected-author.json', {
        id: 'projected-author',
        name: 'Projected Author',
        bio: '同じ保存で追加する著者です。',
      }),
      jsonAddition('src/content/tags/projected-tag.json', {
        id: 'projected-tag',
        name: 'Projected Tag',
        slug: 'projected-tag',
      }),
      {
        path: 'public/uploads/hatt/同時追加.png',
        contents: Buffer.from('validated before reference check').toString(
          'base64',
        ),
      },
      markdownAddition(
        'src/content/blog/projected-entry.md',
        [
          'author: projected-author',
          'tags:',
          '  - projected-tag',
          'image: /uploads/hatt/%E5%90%8C%E6%99%82%E8%BF%BD%E5%8A%A0.png',
        ],
        '![同時追加](/uploads/hatt/%E5%90%8C%E6%99%82%E8%BF%BD%E5%8A%A0.png)',
      ),
    ],
    currentState,
    deletions: [],
  })
})

test('存在しないauthor・tag・画像への参照を拒否する', async (t) => {
  await t.test('author', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          markdownAddition(
            'src/content/blog/missing-author.md',
            ['author: missing-author'],
            '# Missing author',
          ),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /author.*存在しません/.test(error.message),
    )
  })

  await t.test('tag', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          markdownAddition(
            'src/content/blog/missing-tag.md',
            ['author: hatt', 'tags:', '  - missing-tag'],
            '# Missing tag',
          ),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /tag.*存在しません/.test(error.message),
    )
  })

  await t.test('frontmatter image', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          markdownAddition(
            'src/content/blog/missing-image.md',
            ['author: hatt', 'image: /uploads/hatt/missing.png'],
            '# Missing image',
          ),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 &&
        /参照先の画像が存在しません/.test(error.message),
    )
  })
})

test('Markdown画像参照をentity・escape・percent表記でも検出する', async (t) => {
  for (const [name, destination] of [
    ['numeric entity', '&#47;uploads&#47;hatt&#47;missing.png'],
    ['named entity', '&sol;uploads&sol;hatt&sol;missing.png'],
    ['backslash escape', '\\/uploads\\/hatt\\/missing.png'],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        validateProjectedCmsReferences({
          additions: [
            markdownAddition(
              `src/content/blog/reference-${name.replaceAll(' ', '-')}.md`,
              ['author: hatt'],
              `![missing](${destination})`,
            ),
          ],
          currentState,
          deletions: [],
        }),
        (error) =>
          error.status === 422 &&
          /参照先の画像が存在しません/.test(error.message),
      )
    })
  }

  await t.test('percent traversal', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          markdownAddition(
            'src/content/blog/reference-percent-traversal.md',
            ['author: hatt'],
            '![missing](/uploads/hatt/%2e%2e/missing.png)',
          ),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /画像参照が不正です/.test(error.message),
    )
  })
})

test('code内の見かけ上のMarkdown画像は参照として扱わない', async () => {
  await validateProjectedCmsReferences({
    additions: [
      markdownAddition(
        'src/content/blog/code-reference.md',
        ['author: hatt'],
        [
          '```md',
          '![example](/uploads/hatt/does-not-exist.png)',
          '```',
          '',
          '`![inline](/uploads/hatt/also-missing.png)`',
        ].join('\n'),
      ),
    ],
    currentState,
    deletions: [],
  })
})

test('参照中の画像をprojected stateから失わせない', async () => {
  const referencedPath = 'public/uploads/hatt/projected-remove.png'
  const state = [
    ...currentState,
    {
      path: 'src/content/authors/projected-removal.json',
      contents: JSON.stringify({
        id: 'projected-removal',
        name: 'Projected Removal',
        bio: '削除整合性テスト',
        avatar: '/uploads/hatt/projected-remove.png',
      }),
    },
    { path: referencedPath },
  ]

  await assert.rejects(
    validateProjectedCmsReferences({
      additions: [],
      currentState: state,
      deletions: [{ path: referencedPath }],
    }),
    (error) =>
      error.status === 422 && /参照先の画像が存在しません/.test(error.message),
  )
})

test('projected全体でtag slugとblog effective slugの重複を拒否する', async (t) => {
  await t.test('same-mutation tag slug', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          jsonAddition('src/content/tags/projected-route-a.json', {
            id: 'projected-route-a',
            name: 'Projected A',
            slug: 'projected-route',
          }),
          jsonAddition('src/content/tags/projected-route-b.json', {
            id: 'projected-route-b',
            name: 'Projected B',
            slug: 'projected-route',
          }),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /tag route slug.*重複/.test(error.message),
    )
  })

  await t.test('existing tag slug', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          jsonAddition('src/content/tags/projected-announcement.json', {
            id: 'projected-announcement',
            name: 'Projected announcement',
            slug: 'announcement',
          }),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /tag route slug.*重複/.test(error.message),
    )
  })

  await t.test('same-mutation blog effective slug', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          markdownAddition(
            'src/content/blog/projected-route.md',
            ['author: hatt'],
            '# Projected fallback route',
          ),
          markdownAddition(
            'src/content/blog/projected-route-explicit.md',
            ['author: hatt', 'slug: projected-route'],
            '# Projected explicit route',
          ),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /blog route slug.*重複/.test(error.message),
    )
  })

  await t.test('existing blog effective slug', async () => {
    await assert.rejects(
      validateProjectedCmsReferences({
        additions: [
          markdownAddition(
            'src/content/blog/projected-ekaitari.md',
            ['author: hatt', 'slug: ekaitari'],
            '# Existing route collision',
          ),
        ],
        currentState,
        deletions: [],
      }),
      (error) =>
        error.status === 422 && /blog route slug.*重複/.test(error.message),
    )
  })
})

test('異なるtag slugとblog effective slugは同じ保存で追加できる', async () => {
  await validateProjectedCmsReferences({
    additions: [
      jsonAddition('src/content/tags/projected-unique-a.json', {
        id: 'projected-unique-a',
        name: 'Projected unique A',
        slug: 'projected-unique-a',
      }),
      jsonAddition('src/content/tags/projected-unique-b.json', {
        id: 'projected-unique-b',
        name: 'Projected unique B',
        slug: 'projected-unique-b',
      }),
      markdownAddition(
        'src/content/blog/projected-unique-a.md',
        ['author: hatt'],
        '# Projected unique A',
      ),
      markdownAddition(
        'src/content/blog/projected-unique-file.md',
        ['author: hatt', 'slug: projected-unique-b'],
        '# Projected unique B',
      ),
    ],
    currentState,
    deletions: [],
  })
})

test('blog filename由来のroute slugにも共有slug制約を適用する', async () => {
  await assert.rejects(
    validateProjectedCmsReferences({
      additions: [
        markdownAddition(
          'src/content/blog/Unsafe route.md',
          ['author: hatt'],
          '# Unsafe fallback route',
        ),
      ],
      currentState,
      deletions: [],
    }),
    (error) =>
      error.status === 422 && /blog route slugが不正/.test(error.message),
  )
})

test('author idにも共有route slug制約とfilename一致を適用する', async () => {
  await assert.rejects(
    validateProjectedCmsReferences({
      additions: [
        jsonAddition('src/content/authors/Unsafe Author.json', {
          id: 'Unsafe Author',
          name: 'Unsafe Author',
          bio: 'Unsafe author route',
        }),
      ],
      currentState,
      deletions: [],
    }),
    (error) => error.status === 422 && /コンテンツschema/.test(error.message),
  )
})

test('参照state取得を指定commit SHAへ束縛しtruncated treeを拒否する', async () => {
  const snapshotSha = 'a'.repeat(40)
  let requestedUrl = ''

  globalThis.fetch = async (input) => {
    requestedUrl = String(input)

    return jsonResponse({
      sha: 'b'.repeat(40),
      tree: [],
      truncated: true,
    })
  }

  await assert.rejects(
    fetchCmsReferenceState('test-token', snapshotSha),
    (error) => error.status === 502 && /省略/.test(error.message),
  )
  assert.match(
    requestedUrl,
    new RegExp(`/git/trees/${snapshotSha}\\?recursive=1$`),
  )
})

test('参照stateの不正SHAとtruncated blobをfail-closedで拒否する', async (t) => {
  await t.test('invalid tree blob SHA', async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        sha: 'b'.repeat(40),
        truncated: false,
        tree: [
          {
            path: 'src/content/authors/hatt.json',
            type: 'blob',
            sha: 'not-a-sha',
          },
        ],
      })

    await assert.rejects(
      fetchCmsReferenceState('test-token', 'a'.repeat(40)),
      (error) => error.status === 502 && /参照状態が不正/.test(error.message),
    )
  })

  await t.test('truncated GraphQL blob', async () => {
    const authorText = JSON.stringify({
      id: 'hatt',
      name: 'Hatt',
      bio: 'Test author',
    })
    let callCount = 0

    globalThis.fetch = async () => {
      callCount += 1

      if (callCount === 1) {
        return jsonResponse({
          sha: 'b'.repeat(40),
          truncated: false,
          tree: [
            {
              path: 'src/content/authors/hatt.json',
              type: 'blob',
              sha: 'c'.repeat(40),
              size: Buffer.byteLength(authorText),
            },
          ],
        })
      }

      return jsonResponse({
        data: {
          repository: {
            blob0: {
              byteSize: Buffer.byteLength(authorText),
              isBinary: false,
              isTruncated: true,
              text: authorText,
            },
          },
        },
      })
    }

    await assert.rejects(
      fetchCmsReferenceState('test-token', 'a'.repeat(40)),
      (error) =>
        error.status === 502 && /CMS参照元を読み込めません/.test(error.message),
    )
  })

  await t.test('tree text size over 448 KiB', async () => {
    let callCount = 0

    globalThis.fetch = async () => {
      callCount += 1

      return jsonResponse({
        sha: 'b'.repeat(40),
        truncated: false,
        tree: [
          {
            path: 'src/content/authors/hatt.json',
            type: 'blob',
            sha: 'c'.repeat(40),
            size: 448 * 1024 + 1,
          },
        ],
      })
    }

    await assert.rejects(
      fetchCmsReferenceState('test-token', 'a'.repeat(40)),
      (error) => error.status === 503 && /448 KiB/.test(error.message),
    )
    assert.equal(callCount, 1)
  })
})

async function readCurrentReferenceState() {
  const roots = ['src/content', 'public/uploads/hatt']
  const entries = []

  for (const root of roots) {
    const absoluteRoot = path.join(repositoryRoot, root)

    for (const absolutePath of await walkFiles(absoluteRoot)) {
      const repositoryPath = path
        .relative(repositoryRoot, absolutePath)
        .split(path.sep)
        .join('/')

      if (!isCmsReferenceStatePath(repositoryPath)) continue

      entries.push(
        isCmsReferenceTextPath(repositoryPath)
          ? {
              path: repositoryPath,
              contents: await readFile(absolutePath, 'utf8'),
            }
          : { path: repositoryPath },
      )
    }
  }

  return entries
}

async function walkFiles(directory) {
  const files = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath)))
    } else if (entry.isFile()) {
      files.push(absolutePath)
    }
  }

  return files
}

function jsonAddition(filePath, value) {
  return {
    path: filePath,
    contents: Buffer.from(JSON.stringify(value)).toString('base64'),
  }
}

function markdownAddition(filePath, extraFrontmatter, body) {
  const markdown = [
    '---',
    'title: Projected entry',
    'description: Projected reference validation',
    'date: 2026-07-29T12:00+09:00',
    ...extraFrontmatter,
    '---',
    body,
    '',
  ].join('\n')

  return {
    path: filePath,
    contents: Buffer.from(markdown).toString('base64'),
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
