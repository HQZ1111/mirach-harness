import { describe, expect, it } from 'vitest'

import type { SessionsIndexSession } from '@/components/panes/session-manage/session-catalog'
import { archiveQueryMatches, selectArchiveSessions } from './archives-settings'

const session = (over: Partial<SessionsIndexSession>): SessionsIndexSession => ({
  id: 's1',
  path: 'x',
  cwd: 'G:/work/mirach',
  name: 'chat',
  messageCount: 1,
  lastModified: 1000,
  createdAt: 500,
  parentSessionId: null,
  projectId: 'p1',
  profile: null,
  sourceRoot: 'sessionDir',
  source: 'sessionDir',
  ...over,
})

describe('archiveQueryMatches（名称 / cwd，大小写不敏感）', () => {
  it('命中名称或 cwd；空查询全命中', () => {
    expect(archiveQueryMatches(session({ name: 'Weekly Sync' }), 'weekly')).toBe(true)
    expect(archiveQueryMatches(session({ name: null, id: 'abc' }), 'ABC')).toBe(true)
    expect(archiveQueryMatches(session({ cwd: 'G:/Work/Other' }), 'work/other')).toBe(true)
    expect(archiveQueryMatches(session({}), 'nope')).toBe(false)
    expect(archiveQueryMatches(session({}), '  ')).toBe(true)
  })
})

describe('selectArchiveSessions（项目过滤 + 排序）', () => {
  const sessions = [
    session({ id: 'old', projectId: 'p1', lastModified: 100 }),
    session({ id: 'new', projectId: 'p2', lastModified: 300 }),
    session({ id: 'home', projectId: null, lastModified: 200 }),
  ]

  it('更新时间降序（默认）', () => {
    expect(
      selectArchiveSessions(sessions, { query: '', projectKey: 'all', sort: 'updated' }).map(
        (s) => s.id,
      ),
    ).toEqual(['new', 'home', 'old'])
  })

  it('创建时间降序（缺失 createdAt 的排最后）', () => {
    const dated = [
      session({ id: 'old', createdAt: 100 }),
      session({ id: 'new', createdAt: 300 }),
      session({ id: 'none', createdAt: 0, lastModified: 900 }),
    ]
    expect(
      selectArchiveSessions(dated, { query: '', projectKey: 'all', sort: 'created' }).map(
        (s) => s.id,
      ),
    ).toEqual(['new', 'old', 'none'])
  })

  it('项目过滤按分组 key：pj:<id> / w:', () => {
    expect(
      selectArchiveSessions(sessions, { query: '', projectKey: 'pj:p2', sort: 'updated' }).map(
        (s) => s.id,
      ),
    ).toEqual(['new'])
    expect(
      selectArchiveSessions(sessions, { query: '', projectKey: 'w:', sort: 'updated' }).map(
        (s) => s.id,
      ),
    ).toEqual(['home'])
  })
})
