package com.clauderemote.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerAddressTest {
    @Test
    fun aBareNameGetsHttpAndPort4220() {
        val a = ServerAddress.parse("my-pc")!!
        assertEquals("http://my-pc:4220", a.display)
        assertEquals("ws://my-pc:4220/ws", a.ws())
    }

    @Test
    fun aMagicDnsNameWithPortKeepsIt() {
        val a = ServerAddress.parse("  my-pc.tail1234.ts.net:4300/ ")!!
        assertEquals("http://my-pc.tail1234.ts.net:4300", a.display)
        assertEquals("ws://my-pc.tail1234.ts.net:4300/ws?device=d1", a.ws("d1"))
    }

    @Test
    fun aTailnetIpWorks() {
        assertEquals("http://100.101.102.103:4220", ServerAddress.parse("100.101.102.103")!!.display)
    }

    @Test
    fun anExplicitUrlKeepsItsSchemeAndDropsThePath() {
        val a = ServerAddress.parse("https://my-pc.tail1234.ts.net/ignored")!!
        assertEquals("https://my-pc.tail1234.ts.net:4220", a.display)
        assertEquals("wss://my-pc.tail1234.ts.net:4220/ws", a.ws())
        assertEquals("http://h:80", ServerAddress.parse("http://h:80")!!.display)
    }

    @Test
    fun resolvesApiPaths() {
        assertEquals("http://my-pc:4220/api/jobs", ServerAddress.parse("my-pc")!!.http("/api/jobs").toString())
    }

    @Test
    fun rejectsGarbage() {
        assertNull(ServerAddress.parse(""))
        assertNull(ServerAddress.parse("two words"))
        assertNull(ServerAddress.parse("http://"))
    }
}
