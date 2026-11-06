package com.clauderemote.app.sessions

import com.clauderemote.app.protocol.CategoryInfo
import com.clauderemote.app.protocol.Envelope
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.protocol.SessionInfo
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionsStateTest {
    private fun session(id: String, sortOrder: Int = 0, categoryId: String? = null, spawnedBy: String? = null, access: String? = null) =
        SessionInfo(
            id = id, name = "n-$id", shell = "pwsh", cwd = "C:\\p\\$id", createdAt = "2026-11-06T10:00:0$sortOrder.000Z",
            lastAccessedAt = "", status = "running", cols = 80, rows = 24, attachable = true, categoryId = categoryId,
            sortOrder = sortOrder, isFork = false, claudeSessionId = null, spawnedBy = spawnedBy, permissionMode = null,
            access = access, claudeName = null, account = "work", accountWarning = null, revivable = false,
        )

    private fun env(type: String, json: String): Envelope =
        Envelope(type, null, Protocol.json.parseToJsonElement(json))

    private fun envOf(type: String, payload: JsonElement) = Envelope(type, null, payload)

    private val listed = SessionsReducer.reduce(
        SessionsState(),
        envOf("session.list", Protocol.encode(com.clauderemote.app.protocol.SessionListPayload(listOf(session("a"), session("b", 1))))),
    )

    @Test
    fun listThenUpsertRenameDelete() {
        assertEquals(listOf("a", "b"), listed.sessions.map { it.id })
        val added = SessionsReducer.reduce(listed, envOf("session.added", Protocol.encode(com.clauderemote.app.protocol.SessionPayload(session("c", 2)))))
        assertEquals(listOf("a", "b", "c"), added.sessions.map { it.id })
        val renamed = SessionsReducer.reduce(added, env("session.renamed", """{"sessionId":"b","name":"bee"}"""))
        assertEquals("bee", renamed.sessions[1].name)
        val deleted = SessionsReducer.reduce(renamed, env("session.deleted", """{"sessionId":"a"}"""))
        assertEquals(listOf("b", "c"), deleted.sessions.map { it.id })
    }

    @Test
    fun terminatedStaysListedButNotAttachable() {
        val s = SessionsReducer.reduce(listed, env("session.terminated", """{"sessionId":"a"}"""))
        assertEquals(false, s.sessions[0].attachable)
        assertEquals("terminated", s.sessions[0].status)
    }

    @Test
    fun sessionNoticesComeAndGo() {
        val s = SessionsReducer.reduce(listed, env("notification", """{"sessionId":"a","type":"needs-input","timestamp":"t"}"""))
        assertEquals("needs-input", s.notices["a"])
        val land = SessionsReducer.reduce(s, env("notification", """{"kind":"land","projectCwd":"c","track":"t","ok":true,"detail":"d","timestamp":"t"}"""))
        assertEquals(s, land)
        assertNull(SessionsReducer.clearNotice(s, "a").notices["a"])
    }

    @Test
    fun claudeNamesReplaceEveryRow() {
        val named = SessionsReducer.reduce(listed, env("session.claudeNames", """{"names":{"a":"builder"}}"""))
        assertEquals("builder", named.sessions[0].claudeName)
        assertNull(named.sessions[1].claudeName)
    }

    @Test
    fun deletingACategoryUncategorisesItsSessions() {
        val withCat = listed.copy(
            categories = listOf(CategoryInfo("c1", "Games", 0, false)),
            sessions = listOf(session("a", categoryId = "c1")),
        )
        val s = SessionsReducer.reduce(withCat, env("category.deleted", """{"categoryId":"c1"}"""))
        assertEquals(emptyList<CategoryInfo>(), s.categories)
        assertNull(s.sessions[0].categoryId)
    }

    @Test
    fun drawerGroupsNestsAndCollapses() {
        val state = SessionsState(
            sessions = listOf(
                session("loose", 0),
                session("builder", 1, "c1"),
                session("peer", 0, "c1", spawnedBy = "builder", access = "read"),
                session("child", 1, "c1", spawnedBy = "builder"),
                session("hidden", 0, "c2"),
            ),
            categories = listOf(CategoryInfo("c1", "Work", 0, false), CategoryInfo("c2", "Old", 1, true)),
        )
        val rows = DrawerRows.build(state, currentId = "child")
        assertEquals(
            listOf("s:loose", "c:c1", "s:builder", "s:child", "s:peer", "c:c2"),
            rows.map { it.key },
        )
        val child = rows.filterIsInstance<DrawerRow.Session>().first { it.session.id == "child" }
        assertEquals(1, child.depth)
        assertEquals(true, child.current)
        assertEquals(1, (rows.last() as DrawerRow.Category).count)
    }
}
