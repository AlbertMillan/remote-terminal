package com.clauderemote.app.sessions

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** `GET /api/accounts`: the accounts a new session can run under (docs/accounts.md). */
@Serializable
data class AccountsSummary(val defaultAccount: String = "personal", val accounts: List<AccountSummary> = emptyList())

@Serializable
data class AccountSummary(val name: String, val ready: Boolean = true)

/** `GET /api/accounts/resolve?cwd=`: what the empty option means for a folder. */
@Serializable
data class ResolvedAccount(val account: String, val source: String = "default")

/** One row of the New session dialog's Account picker; a null `value` lets the server pick. */
data class AccountOption(val label: String, val value: String?)

object Accounts {
    private val json = Json { ignoreUnknownKeys = true }

    fun summary(body: JsonElement): AccountsSummary = json.decodeFromJsonElement(AccountsSummary.serializer(), body)

    fun resolved(body: JsonElement): ResolvedAccount = json.decodeFromJsonElement(ResolvedAccount.serializer(), body)

    /**
     * The picker's options, as the web modal's `accountOptionsHtml`: first the server's
     * choice (the project's account, else the configured one), then each account. One
     * holding the wrong login is marked and still pickable: picking it is refused.
     */
    fun options(summary: AccountsSummary?, resolved: ResolvedAccount? = null): List<AccountOption> {
        val default = when {
            resolved != null -> "Default (${resolved.account}${if (resolved.source == "project") ", from project" else ""})"
            else -> "Default (project's, else ${summary?.defaultAccount ?: "personal"})"
        }
        return listOf(AccountOption(default, null)) + summary?.accounts.orEmpty().map {
            AccountOption(if (it.ready) it.name else "${it.name} — not logged in as expected", it.name)
        }
    }
}
