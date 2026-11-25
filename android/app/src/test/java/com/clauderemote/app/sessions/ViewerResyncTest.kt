package com.clauderemote.app.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The phone's half of `terminal.resized` ([ViewerResync]): when another viewer resizes the open
 * session, the phone re-attaches on its next use, and only then.
 */
class ViewerResyncTest {
    private val phone = ViewerResync.Size(48, 30)
    private val pc = ViewerResync.Size(268, 50)

    @Test
    fun reattachesOnceOnTheFirstUseAfterAnotherSize() {
        val r = ViewerResync()
        r.resized("s1", pc, "s1", phone)

        assertEquals(pc, r.ptySize("s1"))
        assertEquals("s1", r.take("s1", canAttach = true))
        assertNull(r.take("s1", canAttach = true))
    }

    @Test
    fun ignoresOurOwnSizeAndOtherSessions() {
        val r = ViewerResync()
        r.resized("s1", phone, "s1", phone)
        r.resized("s2", pc, "s1", phone)

        assertNull(r.ptySize("s1"))
        assertNull(r.take("s1", canAttach = true))
    }

    @Test
    fun staysMarkedWhenTheSizeComesBackToOurs() {
        val r = ViewerResync()
        r.resized("s1", pc, "s1", phone)
        r.resized("s1", phone, "s1", phone)

        assertEquals("s1", r.take("s1", canAttach = true))
    }

    @Test
    fun dropsTheMarkWithoutReattachingWhileAnAttachIsInFlight() {
        val r = ViewerResync()
        r.resized("s1", pc, "s1", phone)

        assertNull(r.take("s1", canAttach = false))
        assertNull(r.take("s1", canAttach = true))
    }

    @Test
    fun aFreshSnapshotClearsTheMark() {
        val r = ViewerResync()
        r.resized("s1", pc, "s1", phone)
        r.attached("s1")

        assertNull(r.ptySize("s1"))
        assertNull(r.take("s1", canAttach = true))
    }

    @Test
    fun resetForgetsEverything() {
        val r = ViewerResync()
        r.resized("s1", pc, "s1", phone)
        r.reset()

        assertNull(r.take("s1", canAttach = true))
    }
}
