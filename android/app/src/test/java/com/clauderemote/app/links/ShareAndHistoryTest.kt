package com.clauderemote.app.links

import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.terminal.RemoteTerminalSession
import com.clauderemote.app.ui.history.History
import com.clauderemote.app.ui.history.LogBoard
import org.junit.Assert.assertEquals
import org.junit.Test

class ShareAndHistoryTest {
    @Test
    fun aPasteIsBracketedWhenTheProgramAskedAndNeverSubmitsLineByLine() {
        val shared = "Look at this:\r\nhttps://example.com\nthanks"
        assertEquals(
            "\u001b[200~Look at this:\rhttps://example.com\rthanks\u001b[201~",
            RemoteTerminalSession.preparePaste(shared, bracketed = true),
        )
        assertEquals("a\rb", RemoteTerminalSession.preparePaste("a\nb", bracketed = false))
    }

    @Test
    fun aPasteCannotCloseItsOwnBracket() {
        val hostile = "x\u001b[201~rm -rf /\r"
        val out = RemoteTerminalSession.preparePaste(hostile, bracketed = true)
        assertEquals("\u001b[200~x[201~rm -rf /\r\u001b[201~", out)
    }

    @Test
    fun historyListsResumableEntriesNewestFirst() {
        val json = """
            {"projects":[
              {"cwd":"C:\\a","name":"alpha","hasLog":true,"entries":[
                {"meta":{"date":"2026-11-01T10:00:00Z","session":"old","claudeSessionId":"s-old","account":"work"},
                 "body":"<!-- claude-remote-log {} -->\n## 2026-11-01 · old\n**Account:** work\n**Done:** Fixed the `drawer` scroll.\n**Changed:** x"},
                {"meta":{"date":"2026-11-03T10:00:00Z","session":"no transcript"},"body":"**Done:** nothing"}
              ]},
              {"cwd":"C:\\b","name":"beta","entries":[
                {"meta":{"date":"2026-11-05T10:00:00Z","session":"new","claudeSessionId":"s-new"},"body":"## 2026-11-05 · new\nPlain first line."}
              ]}
            ]}
        """.trimIndent()
        val items = History.items(Protocol.json.decodeFromString(LogBoard.serializer(), json))
        assertEquals(listOf("s-new", "s-old"), items.map { it.claudeSessionId })
        assertEquals("Fixed the drawer scroll.", items[1].summary)
        assertEquals("Plain first line.", items[0].summary)
        assertEquals("work", items[1].account)
    }
}
