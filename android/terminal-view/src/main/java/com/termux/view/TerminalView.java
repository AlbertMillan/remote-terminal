/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink, then for claude-remote: a view over a remote,
 * WebSocket-backed terminal session.
 */
package com.termux.view;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;

import com.termux.terminal.ITerminalSession;
import com.termux.terminal.KeyHandler;
import com.termux.terminal.TerminalColors;
import com.termux.terminal.TerminalEmulator;

import java.util.Arrays;

/**
 * Custom Android {@link View} that displays a terminal emulator session.
 *
 * <p>Responsibilities:</p>
 * <ul>
 *   <li>Renders the terminal buffer via {@link TerminalRenderer}.</li>
 *   <li>Handles touch: tap to focus / show soft keyboard, scroll for scrollback,
 *       long-press to start text selection.</li>
 *   <li>Maps hardware {@link KeyEvent}s to terminal escape sequences via
 *       {@link KeyHandler}.</li>
 *   <li>Provides an {@link InputConnection} so the system soft keyboard can
 *       send text and editing commands to the terminal.</li>
 *   <li>Supports a virtual Ctrl key state so an on-screen extra-keys bar can
 *       send control characters.</li>
 * </ul>
 */
public class TerminalView extends View {

    // ---------------------------------------------------------------------------
    // Client callback interface
    // ---------------------------------------------------------------------------

    /**
     * Callback interface for events originating from the terminal view that the
     * hosting Activity or Fragment may want to react to.
     */
    public interface TerminalViewClient {
        /** The visible text in the terminal has changed. */
        void onTextChanged(ITerminalSession session);

        /** The terminal title (e.g. set via OSC 0/2) has changed. */
        void onTitleChanged(ITerminalSession session);

        /** The terminal bell (BEL, 0x07) was triggered. */
        void onBell(ITerminalSession session);

        /** Log an error from the terminal view. */
        void logError(String tag, String message);

        /** Log a warning from the terminal view. */
        void logWarn(String tag, String message);
    }

    // ---------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------

    private static final String TAG = "TerminalView";

    /** Default background colour used when no session is attached. */
    private static final int DEFAULT_BACKGROUND = 0xFF16161E;

    /** Cursor blink interval in milliseconds. */
    private static final long CURSOR_BLINK_INTERVAL_MS = 500;

    /** Default text size in dp when none is specified. */
    private static final int DEFAULT_TEXT_SIZE_DP = 14;

    // ---------------------------------------------------------------------------
    // Fields
    // ---------------------------------------------------------------------------

    private TerminalRenderer mRenderer;
    private ITerminalSession mSession;
    private TerminalViewClient mClient;

    private final GestureDetector mGestureDetector;
    private final Handler mHandler = new Handler(Looper.getMainLooper());

    /** First visible row in the terminal buffer (0 = current screen, negative = scrollback). */
    private int mTopRow = 0;

    // Text selection state
    private boolean mIsSelectingText = false;
    private int mSelX1 = -1;
    private int mSelY1 = -1;
    private int mSelX2 = -1;
    private int mSelY2 = -1;

    // Selection drag tracking
    private int mSelDragStartCol = -1;
    private int mSelDragStartRow = -1;

    /** Whether the block cursor is currently in its visible phase. */
    private boolean mCursorBlinkVisible = true;

    /** Virtual Ctrl key state, toggled by an on-screen extra-keys bar. */
    private boolean mCtrlDown = false;

    /** The cursor blink runnable so we can remove it when the view is detached. */
    private final Runnable mCursorBlinkRunnable = new Runnable() {
        @Override
        public void run() {
            mCursorBlinkVisible = !mCursorBlinkVisible;
            invalidate();
            mHandler.postDelayed(this, CURSOR_BLINK_INTERVAL_MS);
        }
    };

    // ---------------------------------------------------------------------------
    // Constructors
    // ---------------------------------------------------------------------------

    public TerminalView(Context context) {
        this(context, null);
    }

    public TerminalView(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public TerminalView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        mGestureDetector = new GestureDetector(context, createGestureListener());
        initView(context, DEFAULT_TEXT_SIZE_DP);
    }

    /**
     * Convenience constructor that accepts a custom text size in dp.
     *
     * @param context  Android context
     * @param textSizeDp text size in density-independent pixels
     */
    public TerminalView(Context context, int textSizeDp) {
        super(context);
        mGestureDetector = new GestureDetector(context, createGestureListener());
        initView(context, textSizeDp);
    }

    // ---------------------------------------------------------------------------
    // Initialisation
    // ---------------------------------------------------------------------------

    private void initView(Context context, int textSizeDp) {
        setFocusable(true);
        setFocusableInTouchMode(true);

        float density = context.getResources().getDisplayMetrics().density;
        int textSizePx = Math.round(textSizeDp * density);

        mRenderer = new TerminalRenderer(textSizePx, Typeface.MONOSPACE);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        startCursorBlink();
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        mHandler.removeCallbacks(mCursorBlinkRunnable);
    }

    private void startCursorBlink() {
        mHandler.removeCallbacks(mCursorBlinkRunnable);
        mCursorBlinkVisible = true;
        mHandler.postDelayed(mCursorBlinkRunnable, CURSOR_BLINK_INTERVAL_MS);
    }

    // ---------------------------------------------------------------------------
    // Session management
    // ---------------------------------------------------------------------------

    /**
     * Attach a terminal session to this view. The view will begin rendering the
     * session's emulator buffer and forwarding input to it.
     *
     * @param session the session to attach (must not be {@code null})
     */
    public void attachSession(ITerminalSession session) {
        mSession = session;
        mTopRow = 0;
        clearSelection();
        invalidate();
    }

    /**
     * Detach the current session. The view will show a blank background until
     * a new session is attached.
     */
    public void detachSession() {
        mSession = null;
        clearSelection();
        invalidate();
    }

    /**
     * @return the currently attached session, or {@code null}
     */
    public ITerminalSession getSession() {
        return mSession;
    }

    /**
     * Set the callback client that receives terminal events.
     */
    public void setTerminalViewClient(TerminalViewClient client) {
        mClient = client;
    }

    // ---------------------------------------------------------------------------
    // Ctrl key state (for extra-keys bar)
    // ---------------------------------------------------------------------------

    /**
     * Set the virtual Ctrl key state. When {@code true}, the next alphabetic
     * character committed via the soft keyboard will be converted to the
     * corresponding control character (e.g. 'c' -> 0x03).
     */
    public void setCtrlDown(boolean ctrlDown) {
        mCtrlDown = ctrlDown;
    }

    /** @return whether the virtual Ctrl key is currently engaged */
    public boolean isCtrlDown() {
        return mCtrlDown;
    }

    // ---------------------------------------------------------------------------
    // Geometry
    // ---------------------------------------------------------------------------

    /**
     * Calculate how many columns fit in the current view width based on the
     * monospace font metrics.
     *
     * @return number of columns, at least 4
     */
    public int calculateColumns() {
        if (mRenderer == null || getWidth() == 0) return 80;
        return Math.max(4, (int) (getWidth() / mRenderer.getFontWidth()));
    }

    /**
     * Calculate how many rows fit in the current view height based on the
     * font line spacing.
     *
     * @return number of rows, at least 4
     */
    public int calculateRows() {
        if (mRenderer == null || getHeight() == 0) return 24;
        return Math.max(4, getHeight() / mRenderer.getFontLineSpacing());
    }

    /**
     * Update the renderer with a new text size and typeface.
     *
     * @param textSizePx text size in pixels
     * @param typeface   the monospace typeface to use
     */
    public void setTextSize(int textSizePx, Typeface typeface) {
        mRenderer = new TerminalRenderer(textSizePx, typeface != null ? typeface : Typeface.MONOSPACE);
        invalidate();
    }

    // ---------------------------------------------------------------------------
    // Drawing
    // ---------------------------------------------------------------------------

    @Override
    protected void onDraw(Canvas canvas) {
        if (mSession == null) {
            canvas.drawColor(DEFAULT_BACKGROUND);
            return;
        }

        TerminalEmulator emulator = mSession.getEmulator();
        if (emulator == null) {
            canvas.drawColor(DEFAULT_BACKGROUND);
            return;
        }

        // Fill background
        canvas.drawColor(emulator.getColors().mCurrentColors[TerminalColors.COLOR_INDEX_BACKGROUND]);

        // Render the buffer
        mRenderer.render(emulator, canvas, mTopRow, mSelY1, mSelX1, mSelY2, mSelX2);
    }

    /**
     * Called by the session or an external observer to signal that the terminal
     * buffer has changed and the view should redraw. Safe to call from any thread.
     */
    public void onScreenUpdated() {
        postInvalidate();
    }

    // ---------------------------------------------------------------------------
    // Touch handling
    // ---------------------------------------------------------------------------

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        // Handle selection drag
        if (mIsSelectingText && event.getAction() == MotionEvent.ACTION_MOVE) {
            int col = (int) (event.getX() / mRenderer.getFontWidth());
            int row = mTopRow + (int) (event.getY() / mRenderer.getFontLineSpacing());
            updateSelectionEnd(row, col);
            invalidate();
            return true;
        }

        if (mIsSelectingText && event.getAction() == MotionEvent.ACTION_UP) {
            // Selection complete -- the selected text can be retrieved via getSelectedText()
            mIsSelectingText = false;
            return true;
        }

        return mGestureDetector.onTouchEvent(event) || super.onTouchEvent(event);
    }

    private GestureDetector.SimpleOnGestureListener createGestureListener() {
        return new GestureDetector.SimpleOnGestureListener() {

            @Override
            public boolean onDown(MotionEvent e) {
                // Must return true to receive subsequent events.
                return true;
            }

            @Override
            public boolean onSingleTapUp(MotionEvent e) {
                if (mIsSelectingText) {
                    clearSelection();
                    invalidate();
                    return true;
                }
                requestFocus();
                showSoftKeyboard();
                // Scroll to bottom on tap so the user sees the latest output.
                mTopRow = 0;
                invalidate();
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2,
                                    float distanceX, float distanceY) {
                if (mSession == null) return false;

                int rowDelta = (int) (distanceY / mRenderer.getFontLineSpacing());
                if (rowDelta != 0) {
                    scrollByRows(-rowDelta);
                }
                return true;
            }

            @Override
            public boolean onFling(MotionEvent e1, MotionEvent e2,
                                   float velocityX, float velocityY) {
                if (mSession == null) return false;

                // Coarse fling: convert velocity to a row count.
                int rowDelta = (int) (velocityY / mRenderer.getFontLineSpacing() / 4);
                if (rowDelta != 0) {
                    scrollByRows(rowDelta);
                }
                return true;
            }

            @Override
            public void onLongPress(MotionEvent e) {
                // Begin text selection at the touched position.
                int col = (int) (e.getX() / mRenderer.getFontWidth());
                int row = mTopRow + (int) (e.getY() / mRenderer.getFontLineSpacing());

                mIsSelectingText = true;
                mSelDragStartCol = col;
                mSelDragStartRow = row;
                mSelX1 = col;
                mSelY1 = row;
                mSelX2 = col;
                mSelY2 = row;

                invalidate();
            }
        };
    }

    /**
     * Scroll the viewport by the given number of rows. Positive values scroll
     * toward the bottom (newer output), negative values scroll into the
     * scrollback history.
     */
    private void scrollByRows(int delta) {
        if (mSession == null) return;
        int maxScroll = mSession.getEmulator().mMainBuffer.getActiveTranscriptRows();
        mTopRow = Math.max(-maxScroll, Math.min(0, mTopRow + delta));
        invalidate();
    }

    // ---------------------------------------------------------------------------
    // Text selection
    // ---------------------------------------------------------------------------

    private void updateSelectionEnd(int row, int col) {
        // Always keep sel1 <= sel2 in document order.
        if (row < mSelDragStartRow || (row == mSelDragStartRow && col < mSelDragStartCol)) {
            mSelY1 = row;
            mSelX1 = col;
            mSelY2 = mSelDragStartRow;
            mSelX2 = mSelDragStartCol;
        } else {
            mSelY1 = mSelDragStartRow;
            mSelX1 = mSelDragStartCol;
            mSelY2 = row;
            mSelX2 = col;
        }
    }

    /**
     * Return the text currently selected on screen, or {@code null} if nothing
     * is selected.
     */
    public String getSelectedText() {
        if (mSelY1 < 0 || mSession == null) return null;

        TerminalEmulator emulator = mSession.getEmulator();
        if (emulator == null) return null;

        StringBuilder sb = new StringBuilder();
        for (int row = mSelY1; row <= mSelY2; row++) {
            int startCol = (row == mSelY1) ? mSelX1 : 0;
            int endCol = (row == mSelY2) ? mSelX2 : emulator.getColumns() - 1;

            for (int col = startCol; col <= endCol; col++) {
                char c = emulator.mMainBuffer.allocateFullLineIfNecessary(row).getChar(col);
                if (c != 0) {
                    sb.append(c);
                }
            }
            if (row < mSelY2) {
                sb.append('\n');
            }
        }
        return sb.toString();
    }

    /** Clear the current text selection. */
    public void clearSelection() {
        mIsSelectingText = false;
        mSelX1 = -1;
        mSelY1 = -1;
        mSelX2 = -1;
        mSelY2 = -1;
        mSelDragStartCol = -1;
        mSelDragStartRow = -1;
    }

    /** @return {@code true} if text is currently being selected or is selected */
    public boolean isSelectingText() {
        return mIsSelectingText || mSelY1 >= 0;
    }

    // ---------------------------------------------------------------------------
    // Keyboard / key event handling
    // ---------------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (mSession == null || !mSession.isRunning()) {
            return super.onKeyDown(keyCode, event);
        }

        // Clear selection on any key press.
        if (isSelectingText()) {
            clearSelection();
            invalidate();
        }

        TerminalEmulator emulator = mSession.getEmulator();

        // Build modifier flags compatible with KeyHandler.
        int modifiers = 0;
        if (event.isCtrlPressed() || mCtrlDown) modifiers |= KeyHandler.KEYMOD_CTRL;
        if (event.isAltPressed()) modifiers |= KeyHandler.KEYMOD_ALT;
        if (event.isShiftPressed()) modifiers |= KeyHandler.KEYMOD_SHIFT;

        String code = KeyHandler.getCode(keyCode, modifiers,
                emulator.isCursorKeysApplication(),
                emulator.isKeypadApplication());

        if (code != null) {
            mSession.write(code);
            // Consume the Ctrl state if it was virtual.
            mCtrlDown = false;
            scrollToBottom();
            return true;
        }

        // Let printable characters through to the InputConnection path.
        int unicodeChar = event.getUnicodeChar(
                (event.isShiftPressed() ? KeyEvent.META_SHIFT_ON : 0)
                        | (mCtrlDown ? KeyEvent.META_CTRL_ON : 0));

        if (unicodeChar > 0) {
            if (mCtrlDown) {
                // Ctrl + printable character: generate control code.
                char c = (char) unicodeChar;
                if (c >= 'a' && c <= 'z') {
                    mSession.write(new byte[]{(byte) (c - 'a' + 1)}, 0, 1);
                } else if (c >= 'A' && c <= 'Z') {
                    mSession.write(new byte[]{(byte) (c - 'A' + 1)}, 0, 1);
                } else {
                    mSession.write(String.valueOf(c));
                }
                mCtrlDown = false;
            } else {
                mSession.write(String.valueOf((char) unicodeChar));
            }
            scrollToBottom();
            return true;
        }

        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        // Nothing special needed on key up; let the system handle it.
        return super.onKeyUp(keyCode, event);
    }

    // ---------------------------------------------------------------------------
    // InputConnection (soft keyboard integration)
    // ---------------------------------------------------------------------------

    @Override
    public boolean onCheckIsTextEditor() {
        return true;
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        // TYPE_NULL tells the IME that we handle raw key events ourselves.
        outAttrs.inputType = InputType.TYPE_NULL;
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN;

        return new BaseInputConnection(this, false) {

            @Override
            public boolean commitText(CharSequence text, int newCursorPosition) {
                if (mSession == null) return false;

                String textStr = text.toString();

                if (mCtrlDown && textStr.length() == 1) {
                    char c = textStr.charAt(0);
                    if (c >= 'a' && c <= 'z') {
                        mSession.write(new byte[]{(byte) (c - 'a' + 1)}, 0, 1);
                    } else if (c >= 'A' && c <= 'Z') {
                        mSession.write(new byte[]{(byte) (c - 'A' + 1)}, 0, 1);
                    } else {
                        // Non-alphabetic with Ctrl: send as-is.
                        mSession.write(textStr);
                    }
                    mCtrlDown = false;
                } else {
                    mSession.write(textStr);
                }

                scrollToBottom();
                return true;
            }

            @Override
            public boolean deleteSurroundingText(int beforeLength, int afterLength) {
                if (mSession == null) return false;

                // Send DEL (0x7F) for each character to delete before the cursor.
                if (beforeLength > 0) {
                    byte[] del = new byte[beforeLength];
                    Arrays.fill(del, (byte) 0x7F);
                    mSession.write(del, 0, del.length);
                }

                // Forward delete is unusual in terminals but we map it to the
                // ANSI escape for the Delete key.
                if (afterLength > 0) {
                    for (int i = 0; i < afterLength; i++) {
                        mSession.write("\033[3~");
                    }
                }

                scrollToBottom();
                return true;
            }

            @Override
            public boolean sendKeyEvent(KeyEvent event) {
                if (event.getAction() == KeyEvent.ACTION_DOWN) {
                    return onKeyDown(event.getKeyCode(), event);
                }
                return false;
            }

            @Override
            public boolean performEditorAction(int actionCode) {
                // IME "Done" / "Go" / "Enter" button -> send newline.
                if (mSession != null) {
                    mSession.write("\r");
                    scrollToBottom();
                }
                return true;
            }
        };
    }

    // ---------------------------------------------------------------------------
    // Soft keyboard visibility
    // ---------------------------------------------------------------------------

    /** Request the system to show the soft keyboard for this view. */
    public void showSoftKeyboard() {
        InputMethodManager imm = (InputMethodManager)
                getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.showSoftInput(this, 0);
        }
    }

    /** Request the system to hide the soft keyboard. */
    public void hideSoftKeyboard() {
        InputMethodManager imm = (InputMethodManager)
                getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(getWindowToken(), 0);
        }
    }

    // ---------------------------------------------------------------------------
    // Scrolling helpers
    // ---------------------------------------------------------------------------

    /** Scroll the viewport so that the latest output is visible. */
    public void scrollToBottom() {
        if (mTopRow != 0) {
            mTopRow = 0;
            invalidate();
        }
    }

    /** @return the current top-row offset (negative = in scrollback) */
    public int getTopRow() {
        return mTopRow;
    }

    /** Set the top-row offset directly. */
    public void setTopRow(int topRow) {
        mTopRow = topRow;
        invalidate();
    }
}
