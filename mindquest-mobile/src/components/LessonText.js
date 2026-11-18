/**
 * File: src/components/LessonText.js
 * Purpose: The lesson of a level module, laid out with the same marks as the
 *          website (views/partials/level-lesson.ejs):
 *
 *   "## "      a heading
 *   "- "       a list item           "1. "  a numbered item
 *   "Answer: " the answer to a check question — hidden until "Show answer"
 *
 * The text is shown as plain text: the marks only choose the layout, nothing
 * in a lesson can run as code.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../lib/config';

/** Plain text -> blocks, line by line (the website's blocksOf). */
export function blocksOf(text) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') });
    para = [];
  };
  const listOf = (kind) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) return last;
    const list = { kind, items: [] };
    blocks.push(list);
    return list;
  };
  String(text || '').split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) { flush(); return; }
    let m;
    if ((m = line.match(/^##\s*(.+)$/))) { flush(); blocks.push({ kind: 'heading', text: m[1] }); return; }
    if ((m = line.match(/^(?:answer|sagot)\s*:\s*(.*)$/i))) { flush(); blocks.push({ kind: 'answer', text: m[1] }); return; }
    if ((m = line.match(/^[-*•]\s+(.+)$/))) { flush(); listOf('ul').items.push(m[1]); return; }
    if ((m = line.match(/^\d+[.)]\s+(.+)$/))) { flush(); listOf('ol').items.push(m[1]); return; }
    para.push(line);
  });
  flush();
  return blocks;
}

function Answer({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.answer}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" hitSlop={6}>
        <Text style={styles.answerToggle}>{open ? 'Hide answer' : 'Show answer'}</Text>
      </Pressable>
      {open ? <Text style={styles.para}>{text}</Text> : null}
    </View>
  );
}

/** One part of a lesson: its title and its blocks. */
export function LessonPart({ number, title, text }) {
  return (
    <View style={styles.part}>
      <Text style={styles.partNumber}>Part {number}</Text>
      <Text style={styles.partTitle}>{title}</Text>
      {blocksOf(text).map((block, i) => {
        if (block.kind === 'heading') return <Text key={i} style={styles.heading}>{block.text}</Text>;
        if (block.kind === 'answer') return <Answer key={i} text={block.text} />;
        if (block.kind === 'ul' || block.kind === 'ol') {
          return (
            <View key={i} style={styles.list}>
              {block.items.map((item, j) => (
                <View key={j} style={styles.listRow}>
                  <Text style={styles.bullet}>{block.kind === 'ol' ? `${j + 1}.` : '•'}</Text>
                  <Text style={[styles.para, styles.flex]}>{item}</Text>
                </View>
              ))}
            </View>
          );
        }
        return <Text key={i} style={styles.para}>{block.text}</Text>;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  part: { gap: 6, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  partNumber: { color: COLORS.green, fontWeight: '800', fontSize: 12, textTransform: 'uppercase' },
  partTitle: { color: COLORS.greenDark, fontWeight: '800', fontSize: 17 },
  heading: { color: COLORS.greenDark, fontWeight: '700', fontSize: 15, marginTop: 6 },
  para: { color: COLORS.text, fontSize: 15, lineHeight: 23 },
  list: { gap: 4 },
  listRow: { flexDirection: 'row', gap: 8 },
  bullet: { color: COLORS.green, fontWeight: '800', fontSize: 15, minWidth: 18 },
  answer: { backgroundColor: COLORS.greenSoft, borderRadius: 8, padding: 10, gap: 6 },
  answerToggle: { color: COLORS.greenDark, fontWeight: '700' }
});
