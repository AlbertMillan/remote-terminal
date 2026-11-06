/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink, then for claude-remote: a view over a remote,
 * WebSocket-backed terminal session. claude-remote changes: pixel scrolling
 * with an OverScroller fling, a scroll position that stays on the same text
 * while output arrives, size and selection callbacks, and a sticky Ctrl that
 * tells the host when it is used up.
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
import android.widget.OverScroller;

import com.termux.terminal.ITerminalSession;
import com.termux.terminal.KeyHandler;
import com.termux.terminal.TerminalBuffer;
import com.termux.terminal.TerminalColors;
import com.termux.terminal.TerminalEmulator;

import java.util.Arrays;

/**
 * Displays a terminal session: renders it, scrolls its history with native fling
 * physics, and feeds hardware keys and the soft keyboard to it.
 */
public class TerminalView extends View {

    /** Events the host reacts to. Every method has a default, so hosts take what they need. */
    public interface TerminalViewClient {
        /** The grid that fits the view changed (layout, keyboard, text size). */
        default void onTerminalSizeChanged(int columns, int rows) {}

        /** A long-press selection was made or cleared. */
        default void onSelectionChanged(boolean hasSelection) {}

        /** The sticky Ctrl was used by a key and is off again. */
        default void onCtrlConsumed() {}

        /** The view was tapped (the keyboard is being shown). */
        default void onTapped() {}

        /** The user scrolled away from the bottom, or back to it. */
        default void onScrolledToBottomChanged(boolean atBottom) {}
    }

    private static final int DEFAULT_BACKGROUND = 0xFF16161E;
    private static final long CURSOR_BLINK_INTERVAL_MS = 600;
    private static final int DEFAULT_TEXT_SIZE_DP = 12;

    private TerminalRenderer mRenderer;
    private ITerminalSession mSession;
    private TerminalViewClient mClient;

    private final GestureDetector mGestureDetector;
    private final OverScroller mScroller;
    private final Handler mHandler = new Handler(Looper.getMainLooper());

    /**
     * Scroll position in pixels: 0 shows the live screen, negative values look into the
     * history. Row = floor(px / line height), and the remainder is drawn as an offset,
     * which is what makes a drag follow the finger instead of jumping a line at a time.
     */
    private int mScrollPx = 0;
    /** The buffer's scroll counter when last drawn, so arriving output keeps us in place. */
    private long mLastScrollCounter = 0;
    private TerminalEmulator mLastEmulator;
    private boolean mAtBottom = true;

    private int mSelX1 = -1, mSelY1 = -1, mSelX2 = -1, mSelY2 = -1;
    private int mSelAnchorCol = -1, mSelAnchorRow = -1;
    private boolean mSelecting = false;

    private boolean mCursorBlinkVisible = true;
    private boolean mCtrlDown = false;
    private int mLastColumns = -1, mLastRows = -1;

    private final Runnable mCursorBlinkRunnable = new Runnable() {
        @Override
        public void run() {
            mCursorBlinkVisible = !mCursorBlinkVisible;
            invalidate();
            mHandler.postDelayed(this, CURSOR_BLINK_INTERVAL_MS);
        }
    };

    public TerminalView(Context context) {
        this(context, null);
    }

    public TerminalView(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public TerminalView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        mGestureDetector = new GestureDetector(context, createGestureListener());
        mGestureDetector.setIsLongpressEnabled(true);
        mScroller = new OverScroller(context);
        setFocusable(true);
        setFocusableInTouchMode(true);
        setTextSizeDp(DEFAULT_TEXT_SIZE_DP);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        restartCursorBlink();
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        mHandler.removeCallbacks(mCursorBlinkRunnable);
    }

    private void restartCursorBlink() {
        mHandler.removeCallbacks(mCursorBlinkRunnable);
        mCursorBlinkVisible = true;
        mHandler.postDelayed(mCursorBlinkRunnable, CURSOR_BLINK_INTERVAL_MS);
    }

    // ---- Session ----

    public void attachSession(ITerminalSession session) {
        mSession = session;
        mScroller.forceFinished(true);
        mScrollPx = 0;
        mLastEmulator = null;
        clearSelection();
        setAtBottom(true);
        invalidate();
    }

    public void detachSession() {
        mSession = null;
        clearSelection();
        invalidate();
    }

    public ITerminalSession getSession() {
        return mSession;
    }

    public void setTerminalViewClient(TerminalViewClient client) {
        mClient = client;
    }

    // ---- Sticky Ctrl (keys bar) ----

    public void setCtrlDown(boolean ctrlDown) {
        mCtrlDown = ctrlDown;
    }

    public boolean isCtrlDown() {
        return mCtrlDown;
    }

    private void consumeCtrl() {
        if (mCtrlDown) {
            mCtrlDown = false;
            if (mClient != null) mClient.onCtrlConsumed();
        }
    }

    // ---- Geometry ----

    public int calculateColumns() {
        if (getWidth() == 0) return 80;
        return Math.max(4, (int) ((getWidth() - getPaddingLeft() - getPaddingRight()) / mRenderer.getFontWidth()));
    }

    public int calculateRows() {
        if (getHeight() == 0) return 24;
        return Math.max(4, (getHeight() - getPaddingTop() - getPaddingBottom()) / mRenderer.getFontLineSpacing());
    }

    public void setTextSizeDp(float textSizeDp) {
        float density = getResources().getDisplayMetrics().density;
        setTextSize(Math.round(textSizeDp * density), Typeface.MONOSPACE);
    }

    public void setTextSize(int textSizePx, Typeface typeface) {
        mRenderer = new TerminalRenderer(textSizePx, typeface != null ? typeface : Typeface.MONOSPACE);
        mScrollPx = 0;
        reportSize();
        invalidate();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        reportSize();
    }

    private void reportSize() {
        if (getWidth() == 0 || getHeight() == 0) return;
        int cols = calculateColumns();
        int rows = calculateRows();
        if (cols == mLastColumns && rows == mLastRows) return;
        mLastColumns = cols;
        mLastRows = rows;
        if (mClient != null) mClient.onTerminalSizeChanged(cols, rows);
    }

    // ---- Drawing ----

    @Override
    protected void onDraw(Canvas canvas) {
        // drawColor fills the canvas clip, which inside a Compose AndroidView is not this
        // view's bounds: without this the background paints over the app bar above.
        canvas.clipRect(0, 0, getWidth(), getHeight());
        TerminalEmulator emulator = mSession != null ? mSession.getEmulator() : null;
        if (emulator == null) {
            canvas.drawColor(DEFAULT_BACKGROUND);
            return;
        }
        canvas.drawColor(emulator.getColors().mCurrentColors[TerminalColors.COLOR_INDEX_BACKGROUND]);

        final int lineHeight = mRenderer.getFontLineSpacing();
        TerminalBuffer main = emulator.mMainBuffer;
        long counter = main.getScrollCounter();
        if (emulator != mLastEmulator) {
            mLastEmulator = emulator;
            mLastScrollCounter = counter;
        } else if (counter != mLastScrollCounter) {
            // Output pushed lines into the history: stay on the text being read.
            if (mScrollPx < 0) mScrollPx -= (int) (counter - mLastScrollCounter) * lineHeight;
            mLastScrollCounter = counter;
        }
        if (emulator.isAlternateBufferActive()) mScrollPx = 0;
        mScrollPx = clampScroll(mScrollPx);

        int topRow = Math.floorDiv(mScrollPx, lineHeight);
        int offset = mScrollPx - topRow * lineHeight;
        canvas.save();
        canvas.translate(getPaddingLeft(), getPaddingTop());
        mRenderer.render(emulator, canvas, topRow, offset, mSelY1, mSelX1, mSelY2, mSelX2,
                mCursorBlinkVisible && mScrollPx == 0);
        canvas.restore();
        setAtBottom(mScrollPx == 0);
    }

    private int minScroll() {
        if (mSession == null || mSession.getEmulator() == null) return 0;
        TerminalEmulator emulator = mSession.getEmulator();
        if (emulator.isAlternateBufferActive()) return 0;
        return -emulator.mMainBuffer.getActiveTranscriptRows() * mRenderer.getFontLineSpacing();
    }

    private int clampScroll(int px) {
        return Math.max(minScroll(), Math.min(0, px));
    }

    /** Safe to call from any thread: the buffer changed. */
    public void onScreenUpdated() {
        postInvalidateOnAnimation();
    }

    @Override
    public void computeScroll() {
        if (mScroller.computeScrollOffset()) {
            mScrollPx = clampScroll(mScroller.getCurrY());
            postInvalidateOnAnimation();
        }
    }

    private void setAtBottom(boolean atBottom) {
        if (atBottom != mAtBottom) {
            mAtBottom = atBottom;
            if (mClient != null) mClient.onScrolledToBottomChanged(atBottom);
        }
    }

    // ---- Touch ----

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (mSelecting) {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_MOVE) {
                updateSelectionEnd(rowAt(event.getY()), colAt(event.getX()));
                invalidate();
                return true;
            }
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                mSelecting = false;
                if (mClient != null) mClient.onSelectionChanged(true);
                return true;
            }
        }
        boolean handled = mGestureDetector.onTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN && getParent() != null) {
            // Scrolling the terminal must not be stolen by an enclosing scroll container.
            getParent().requestDisallowInterceptTouchEvent(true);
        }
        return handled || super.onTouchEvent(event);
    }

    private int colAt(float x) {
        return Math.max(0, (int) ((x - getPaddingLeft()) / mRenderer.getFontWidth()));
    }

    private int rowAt(float y) {
        return Math.floorDiv(mScrollPx + (int) (y - getPaddingTop()), mRenderer.getFontLineSpacing());
    }

    private GestureDetector.SimpleOnGestureListener createGestureListener() {
        return new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                mScroller.forceFinished(true);
                return true;
            }

            @Override
            public boolean onSingleTapUp(MotionEvent e) {
                if (hasSelection()) {
                    clearSelection();
                    if (mClient != null) mClient.onSelectionChanged(false);
                    invalidate();
                    return true;
                }
                requestFocus();
                showSoftKeyboard();
                if (mClient != null) mClient.onTapped();
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2, float distanceX, float distanceY) {
                if (mSession == null) return false;
                mScrollPx = clampScroll(mScrollPx + Math.round(distanceY));
                invalidate();
                return true;
            }

            @Override
            public boolean onFling(MotionEvent e1, MotionEvent e2, float velocityX, float velocityY) {
                if (mSession == null) return false;
                mScroller.forceFinished(true);
                mScroller.fling(0, mScrollPx, 0, Math.round(-velocityY), 0, 0, minScroll(), 0);
                postInvalidateOnAnimation();
                return true;
            }

            @Override
            public void onLongPress(MotionEvent e) {
                int col = colAt(e.getX());
                int row = rowAt(e.getY());
                mSelecting = true;
                mSelAnchorCol = col;
                mSelAnchorRow = row;
                mSelX1 = mSelX2 = col;
                mSelY1 = mSelY2 = row;
                performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
                invalidate();
            }
        };
    }

    // ---- Selection ----

    private void updateSelectionEnd(int row, int col) {
        if (row < mSelAnchorRow || (row == mSelAnchorRow && col < mSelAnchorCol)) {
            mSelY1 = row; mSelX1 = col; mSelY2 = mSelAnchorRow; mSelX2 = mSelAnchorCol;
        } else {
            mSelY1 = mSelAnchorRow; mSelX1 = mSelAnchorCol; mSelY2 = row; mSelX2 = col;
        }
    }

    public boolean hasSelection() {
        return mSelY1 >= 0;
    }

    /** The selected text, or null when nothing is selected. */
    public String getSelectedText() {
        if (!hasSelection() || mSession == null || mSession.getEmulator() == null) return null;
        TerminalEmulator emulator = mSession.getEmulator();
        int maxCol = emulator.getColumns() - 1;
        return emulator.getScreen().getSelectedText(
                Math.min(mSelX1, maxCol), mSelY1, Math.min(mSelX2, maxCol), mSelY2);
    }

    public void clearSelection() {
        mSelecting = false;
        mSelX1 = mSelY1 = mSelX2 = mSelY2 = -1;
        mSelAnchorCol = mSelAnchorRow = -1;
        invalidate();
    }

    // ---- Keys ----

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (mSession == null || !mSession.isRunning()) return super.onKeyDown(keyCode, event);
        if (keyCode == KeyEvent.KEYCODE_BACK) return super.onKeyDown(keyCode, event);

        TerminalEmulator emulator = mSession.getEmulator();
        int modifiers = 0;
        if (event.isCtrlPressed() || mCtrlDown) modifiers |= KeyHandler.KEYMOD_CTRL;
        if (event.isAltPressed()) modifiers |= KeyHandler.KEYMOD_ALT;
        if (event.isShiftPressed()) modifiers |= KeyHandler.KEYMOD_SHIFT;

        String code = KeyHandler.getCode(keyCode, modifiers,
                emulator.isCursorKeysApplication(), emulator.isKeypadApplication());
        if (code != null) {
            mSession.write(code);
            consumeCtrl();
            scrollToBottom();
            return true;
        }

        int unicodeChar = event.getUnicodeChar(event.isShiftPressed() ? KeyEvent.META_SHIFT_ON : 0);
        if (unicodeChar > 0) {
            if (event.isCtrlPressed()) mCtrlDown = true;
            writeText(new String(Character.toChars(unicodeChar)), event.isAltPressed());
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /** Text from a key or the IME, with the sticky Ctrl applied to a single character. */
    private void writeText(String text, boolean alt) {
        if (mSession == null) return;
        if (mCtrlDown && text.length() == 1) {
            byte control = controlByte(text.charAt(0));
            if (control >= 0) {
                mSession.write(new byte[]{control}, 0, 1);
            } else {
                mSession.write(text);
            }
            consumeCtrl();
        } else {
            mSession.write(alt ? "\033" + text : text);
        }
        scrollToBottom();
    }

    /** Ctrl+letter and the punctuation terminals map (Ctrl+[ is Esc, Ctrl+Space NUL); -1 for none. */
    public static byte controlByte(char c) {
        if (c >= 'a' && c <= 'z') return (byte) (c - 'a' + 1);
        if (c >= 'A' && c <= 'Z') return (byte) (c - 'A' + 1);
        switch (c) {
            case ' ': case '2': case '@': return 0;
            case '[': case '3': return 27;
            case '\\': case '4': return 28;
            case ']': case '5': return 29;
            case '^': case '6': return 30;
            case '_': case '7': case '/': return 31;
            case '8': case '?': return 127;
            default: return -1;
        }
    }

    @Override
    public boolean onCheckIsTextEditor() {
        return true;
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        // TYPE_NULL: the keyboard sends key events and plain commits, never a composing
        // region a terminal cannot edit, and offers no autocorrect.
        outAttrs.inputType = InputType.TYPE_NULL;
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN | EditorInfo.IME_FLAG_NO_EXTRACT_UI;

        return new BaseInputConnection(this, false) {
            @Override
            public boolean commitText(CharSequence text, int newCursorPosition) {
                writeText(text.toString().replace('\n', '\r'), false);
                return true;
            }

            @Override
            public boolean deleteSurroundingText(int beforeLength, int afterLength) {
                if (mSession == null) return false;
                if (beforeLength > 0) {
                    byte[] del = new byte[beforeLength];
                    Arrays.fill(del, (byte) 0x7F);
                    mSession.write(del, 0, del.length);
                }
                for (int i = 0; i < afterLength; i++) mSession.write("\033[3~");
                scrollToBottom();
                return true;
            }

            @Override
            public boolean sendKeyEvent(KeyEvent event) {
                if (event.getAction() == KeyEvent.ACTION_DOWN) return onKeyDown(event.getKeyCode(), event);
                return true;
            }

            @Override
            public boolean performEditorAction(int actionCode) {
                if (mSession != null) {
                    mSession.write("\r");
                    scrollToBottom();
                }
                return true;
            }
        };
    }

    public void showSoftKeyboard() {
        requestFocus();
        InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(this, 0);
    }

    public void hideSoftKeyboard() {
        InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(getWindowToken(), 0);
    }

    // ---- Scrolling ----

    public void scrollToBottom() {
        mScroller.forceFinished(true);
        if (mScrollPx != 0) {
            mScrollPx = 0;
            invalidate();
        }
        restartCursorBlink();
    }

    public boolean isAtBottom() {
        return mScrollPx == 0;
    }
}
