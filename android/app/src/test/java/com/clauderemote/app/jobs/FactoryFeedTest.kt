package com.clauderemote.app.jobs

import com.clauderemote.app.protocol.FactoryFeatureProgress
import com.clauderemote.app.protocol.FactoryUnitSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The factory rows' order, labels and when a unit can be released from the app. */
class FactoryFeedTest {
    private fun unit(
        key: String,
        column: String,
        status: String = "in_progress",
        needsYou: Boolean = false,
        features: List<FactoryFeatureProgress> = emptyList(),
        escalated: Boolean = false,
        triage: Boolean = false,
    ) = FactoryUnitSummary(
        key = key, projectCwd = "C:/p", projectName = "p", unitId = key, isTrack = features.isNotEmpty(), trackName = "T",
        title = key, featureIds = listOf("f-$key"), column = column, status = status, step = null, needsYou = needsYou,
        reviewer = null, escalated = escalated, triage = triage, reason = null, features = features, waitsFor = emptyList(),
        mergeId = null, mergeStatus = null, tokens = 0, modelTier = null, stalled = null, heartbeatAt = null, updatedAt = "",
    )

    @Test
    fun putsWhatNeedsYouFirstAndDropsDone() {
        val units = listOf(
            unit("ready", "ready", "open"),
            unit("done", "done", "done"),
            unit("run", "running"),
            unit("mine", "review", "parked", needsYou = true),
        )
        assertEquals(listOf("mine", "run", "ready"), JobsFeed.liveUnits(units).map { it.key })
    }

    @Test
    fun labelsAUnitByWhereItIs() {
        val track = unit(
            "t", "running",
            features = listOf(FactoryFeatureProgress("a", "A", "done"), FactoryFeatureProgress("b", "B", "now"), FactoryFeatureProgress("c", "C", "todo")),
        )
        assertEquals("feature 2 of 3", JobsFeed.unitLabel(track))
        assertEquals("escalated", JobsFeed.unitLabel(unit("r", "review", "parked", needsYou = true, escalated = true)))
        assertEquals("agent reviewing", JobsFeed.unitLabel(unit("r", "review")))
        assertEquals("triage", JobsFeed.unitLabel(unit("i", "intake", "open", needsYou = true, triage = true)))
    }

    @Test
    fun releasesOnlyAnEngineParkNotTriageOrAMerge() {
        assertTrue(JobsFeed.canRelease(unit("r", "review", "parked", needsYou = true)))
        assertFalse(JobsFeed.canRelease(unit("m", "merging", "parked", needsYou = true)))
        assertFalse(JobsFeed.canRelease(unit("i", "intake", "parked", needsYou = true, triage = true)))
        assertFalse(JobsFeed.canRelease(unit("x", "running")))
    }
}
