# kotlinx.serialization ships its own R8 rules; these keep the app's @Serializable
# companions reachable when only reached through serializer<T>() at runtime.
-keepclassmembers @kotlinx.serialization.Serializable class com.clauderemote.app.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep class com.clauderemote.app.**$$serializer { *; }

# The Termux terminal view is created from Kotlin only; nothing reflective, but keep
# its client interface's default methods intact.
-keep interface com.termux.view.TerminalView$TerminalViewClient { *; }
