package com.clauderemote.app.sessions

import com.clauderemote.app.protocol.Protocol
import org.junit.Assert.assertEquals
import org.junit.Test

class AccountsTest {
    // The shape of src/server/accounts.ts accountsSummary(), extra fields included.
    private val summary = Accounts.summary(
        Protocol.json.parseToJsonElement(
            """{"defaultAccount":"work","accounts":[{"name":"personal","ready":true,"setupMissing":[]},{"name":"work","ready":false,"setupMissing":["hooks"]}]}""",
        ),
    )

    @Test
    fun defaultFirstThenEachAccountWithTheWrongLoginMarked() {
        assertEquals(
            listOf(
                AccountOption("Default (project's, else work)", null),
                AccountOption("personal", "personal"),
                AccountOption("work — not logged in as expected", "work"),
            ),
            Accounts.options(summary),
        )
    }

    @Test
    fun defaultNamesWhatItResolvesToForTheFolder() {
        val fromProject = Accounts.resolved(Protocol.json.parseToJsonElement("""{"account":"personal","source":"project"}"""))
        assertEquals("Default (personal, from project)", Accounts.options(summary, fromProject).first().label)
        assertEquals("Default (work)", Accounts.options(summary, ResolvedAccount("work", "default")).first().label)
    }

    @Test
    fun withoutTheListOnlyDefaultIsOffered() {
        assertEquals(listOf(AccountOption("Default (project's, else personal)", null)), Accounts.options(null))
    }
}
