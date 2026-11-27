package com.clauderemote.app.links

import com.clauderemote.app.push.Notifications
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkTest {
    @Test
    fun roundTripsEveryKind() {
        val links = listOf(
            Link.Session("6f1c2b9e-0d4a-4e57-9a43-2c1d0e8b7a11"),
            Link.Unit("c:/users/x/proj|track:Name"),
            Link.Project("C:\\Users\\Albert\\Node Projects\\claude-remote"),
            Link.Project("/home/a/b+c & d"),
        )
        for (link in links) assertEquals(link, Link.parse(link.toUri()))
    }

    @Test
    fun readsWhatThePushNames() {
        assertEquals(Link.Session("s-1"), Link.fromPush(mapOf("kind" to "session", "sessionId" to "s-1")))
        assertEquals(Link.Unit("c:/p|track:T"), Link.fromPush(mapOf("kind" to "factory", "event" to "parked", "unitKey" to "c:/p|track:T")))
        assertEquals(Link.Project("C:\\p"), Link.fromPush(mapOf("kind" to "project", "projectCwd" to "C:\\p")))
        assertNull(Link.fromPush(mapOf("kind" to "weather")))
    }

    @Test
    fun refusesAnythingElse() {
        assertNull(Link.parse(null))
        assertNull(Link.parse("https://example.com/session/x"))
        assertNull(Link.parse("claude-remote://session/../../etc"))
        assertNull(Link.parse("claude-remote://session/"))
        assertNull(Link.parse("claude-remote://project"))
        assertNull(Link.parse("claude-remote://unit"))
        assertNull(Link.parse("claude-remote://unit?key=%"))
        assertNull(Link.parse("claude-remote://unknown/x"))
    }

    @Test
    fun picksAChannelAndOneTagPerSubject() {
        val input = mapOf("kind" to "session", "event" to "needs-input", "sessionId" to "s-1")
        val done = mapOf("kind" to "session", "event" to "completed", "sessionId" to "s-1")
        assertEquals(Notifications.CHANNEL_INPUT, Notifications.channelFor(input))
        assertEquals(Notifications.CHANNEL_DONE, Notifications.channelFor(done))
        assertEquals(Notifications.CHANNEL_JOBS, Notifications.channelFor(mapOf("kind" to "factory")))
        assertEquals(Notifications.CHANNEL_LAND, Notifications.channelFor(mapOf("kind" to "project")))
        // "Finished" replaces "needs input" for the same session rather than stacking.
        assertEquals(Notifications.tagFor(input), Notifications.tagFor(done))
    }
}
