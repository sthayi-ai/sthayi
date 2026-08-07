import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY: the published threat model is what a reader decides with, so it has to be complete AND it
 * has to be honest about the consequences of each residual.
 *
 * Portable Node exposes no `mkdirat`, `openat`, `renameat` or `unlinkat`, so several operations are
 * aimed at a NAME and not at an object. Four intervals follow from that, and they do not have the
 * same consequence:
 *
 *   1. ANCESTOR RETARGETING — the chain is validated by pathname, and the syscalls that follow
 *      resolve those names again.
 *   2. A FRESH HOME — `mkdir` returns no handle, so a directory standing at the name when the first
 *      `open` happens becomes the boundary. On a FIRST establishment there is no registered
 *      identity to compare it against, so this outcome is SILENT: both launchers are written into
 *      the adopted directory and the command reports success.
 *   3. LAUNCHER PUBLICATION — between the last identity read and the `rename`, the temp name can be
 *      made to denote another inode. The published entry is re-read afterwards, so this one is
 *      caught and refused after the fact.
 *   4. CLEANUP — between the same identity read and the `unlink`, the temp name can be made to
 *      denote another inode, and the unlink then removes an entry this run did not create.
 *
 * A model that describes every outcome as detectable understates 2 and 4. This file holds the
 * published text to the four residuals and to the consequence each one really has, and holds the
 * module comments to the same statement so source and policy cannot drift apart.
 *
 * Nothing here spawns a process or writes to the filesystem.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
/** Markdown and comments hard-wrap, so a claim routinely straddles a newline. */
const flat = (rel: string): string => read(rel).replace(/\s+/g, ' ');

const SECURITY = 'SECURITY.md';
const FS_SAFE = 'packages/cli/src/fs-safe.ts';
const LAUNCHER = 'packages/cli/src/clients/launcher.ts';

describe('safety: the published threat model covers every interval, with its real consequence', () => {
  it('names all four intervals', () => {
    const text = flat(SECURITY);
    expect(text, 'ancestor retargeting is not published').toMatch(
      /ancestor[^.]{0,120}(?:retarget|repoint)/i,
    );
    expect(text, 'the fresh-home creation interval is not published').toMatch(
      /mkdir[^.]{0,200}open|fresh home/i,
    );
    expect(text, 'the launcher publication interval is not published').toMatch(
      /rename[^.]{0,200}publish|publish[^.]{0,200}rename/i,
    );
    expect(text, 'the cleanup interval is not published').toMatch(/unlink/i);
  });

  it('says the fresh-home adoption is SILENT — success is reported over it', () => {
    const text = flat(SECURITY);
    expect(text).toMatch(/silent/i);
    // The three parts of that outcome: adopted as the boundary, both launchers written, success
    // reported. A reader who is told only "a directory can be substituted" learns none of them.
    expect(text).toMatch(/adopt/i);
    expect(text).toMatch(/both launchers/i);
    expect(text).toMatch(/reports? success|success is reported/i);
  });

  it('says the cleanup unlink can remove the entry that replaced ours', () => {
    const text = flat(SECURITY);
    expect(text).toMatch(
      /unlink[^.]{0,260}(?:replacement|entry (?:this run|it) did not create|foreign entry)/i,
    );
  });

  it('claims no blanket detectability', () => {
    const text = flat(SECURITY);
    // The blanket sentence, in the shapes it takes.
    expect(text).not.toMatch(/detectable rather than silent/i);
    expect(text).not.toMatch(/(?:all|every|both)[^.]{0,80}outcomes?[^.]{0,60}detectable/i);
    // Detection may still be claimed where it is real — but only next to what it does not cover.
    if (/detect/i.test(text)) {
      expect(text).toMatch(/detection, not prevention|not (?:all|every)|except|silent/i);
    }
  });

  it('keeps the precondition that governs the intervals', () => {
    const text = flat(SECURITY);
    expect(text).toMatch(/root|same uid|user'?s own uid|own account/i);
    expect(text).toMatch(/no claim of protection against root|makes no claim/i);
  });

  it('the module comments do not contradict it', () => {
    const fsSafe = flat(FS_SAFE);
    // A first establishment has nothing to compare against, so it cannot be described as detectable.
    expect(
      /DETECTABLE \(the gate\/descriptor identity comparison refuses it\) rather than silently adopted/i.test(
        fsSafe,
      ),
      'fs-safe.ts calls the creation substitution detectable rather than silently adopted',
    ).toBe(false);
    // It has to say which case is which: an already-registered boundary is compared and refused; a
    // first establishment adopts whatever stands at the name.
    expect(fsSafe).toMatch(/first establish|no registered identity|nothing to compare/i);
    expect(fsSafe).toMatch(/already established|re-establish|registered identity/i);
    // And the launcher module's cleanup comment must state the same residual as the policy.
    expect(flat(LAUNCHER)).toMatch(
      /unlink[^.]{0,300}(?:replacement|entry (?:this run|it) did not create)/i,
    );
  });

  it('both surfaces point at the same statement', () => {
    // The module comments defer to the published model rather than restating a shorter version.
    expect(flat(FS_SAFE)).toMatch(/SECURITY\.md/);
    expect(flat(LAUNCHER)).toMatch(/SECURITY\.md/);
  });
});

/**
 * SAFETY: "the only principals who can reach any of these intervals are root and the user's own uid"
 * is a conclusion drawn ENTIRELY from the enforcement model Sthayi implements — the owning uid and
 * the POSIX permission bits, and nothing else. It is not a property of the filesystem, and it is not
 * universal. Two mechanisms decide access by something those two fields do not describe:
 *
 *   - an EXTENDED ACL (macOS `chmod +a`, Linux `setfacl`/POSIX.1e) can grant a DIFFERENT user write
 *     on a directory whose owner and mode read exactly like a private 0700 one — the uid and the
 *     mode bits are byte-identical with the entry present and without it;
 *   - a NETWORK FILESYSTEM (NFS, SMB/CIFS, sshfs, container/VM shared mounts) decides by the
 *     server's identity mapping, `no_root_squash`/`all_squash` export semantics, or a mount-wide
 *     uid/gid override, so the owner and mode read on the client may describe no principal set.
 *
 * Stating the bound without its scope tells a reader on either of those that an unprivileged peer
 * cannot reach the intervals, when one may. And the correction must not overshoot in the other
 * direction: portable Node exposes NO ACL interface and no filesystem-type classification, so
 * neither case is detected and the document may not read as though the user gets warned.
 */
describe('safety: the reachable-principal bound is scoped to the model that produces it', () => {
  it('ties the "root or the user\'s own uid" conclusion to the enforcement model', () => {
    const text = flat(SECURITY);
    expect(text, 'the conclusion is not scoped to the POSIX uid/ownership/mode-bit model').toMatch(
      /within the POSIX uid\/ownership\/mode-bit model/i,
    );
    expect(text, 'the scope is not stated as exclusive').toMatch(/and only within it/i);
    expect(
      text,
      'the bound is not attributed to the enforcement model rather than to the filesystem',
    ).toMatch(/consequence of the enforcement model, not a property of the filesystem/i);
  });

  it('names extended ACLs and what they do to a 0700-reading directory', () => {
    const text = flat(SECURITY);
    expect(text, 'extended ACLs are not named').toMatch(/extended ACLs?/i);
    expect(text, 'no platform mechanism is named for setting one').toMatch(/chmod \+a/);
    expect(text, 'the Linux/POSIX.1e form is not named').toMatch(/setfacl/i);
    // The specific fact that makes an ACL invisible here: the two fields Sthayi reads are unchanged.
    expect(text, 'the ACL grant to a DIFFERENT user is not stated').toMatch(
      /grant a DIFFERENT user[^.]{0,160}0700/i,
    );
    expect(text, 'it is not said that an ACL leaves uid and mode bits unchanged').toMatch(
      /changes neither the owning uid nor the permission bits/i,
    );
  });

  it('names network filesystems and what decides access there instead', () => {
    const text = flat(SECURITY);
    expect(text, 'NFS is not named').toMatch(/\bNFS\b/);
    expect(text, 'SMB/CIFS is not named').toMatch(/SMB\/CIFS|\bSMB\b|\bCIFS\b/);
    expect(text, 'sshfs and shared container/VM mounts are not named').toMatch(/sshfs/i);
    expect(text, "the server's mapping is not named as the deciding mechanism").toMatch(
      /server'?s identity mapping/i,
    );
    expect(text, 'the export semantics that break the root assumption are not named').toMatch(
      /no_root_squash|all_squash/i,
    );
    expect(text, 'a mount-wide uid override is not named').toMatch(/mount-wide uid/i);
  });

  it('says the reachable principal set is then whatever that mechanism grants', () => {
    const text = flat(SECURITY);
    expect(text, 'the bound is not said to fail where something else decides').toMatch(
      /the bound does not hold/i,
    );
    expect(text, 'the replacement principal set is not stated').toMatch(
      /whatever that mechanism grants/i,
    );
  });

  it('does not imply Sthayi detects or warns about either case', () => {
    const text = flat(SECURITY);
    // Said plainly, because a scoping note that omits it reads like a check that runs.
    expect(text, 'the absence of detection is not stated').toMatch(
      /does not detect either condition and does not warn about it/i,
    );
    // And the reason, so the omission does not read as an oversight someone can "just fix".
    expect(text, 'the missing ACL interface in portable Node is not stated').toMatch(
      /portable Node exposes no ACL interface/i,
    );
    expect(text, 'the limits of what statfs reports are not stated').toMatch(
      /statfs[^.]{0,200}(?:no filesystem name|no mount source|no mount flags)/i,
    );
    // The overclaim this test exists to prevent, in the shapes it would take.
    expect(text).not.toMatch(
      /(?:detects|warns)[^.]{0,100}(?:extended ACL|access control list|network filesystem)/i,
    );
    expect(text).not.toMatch(
      /(?:refuses|rejects)[^.]{0,100}(?:extended ACL|access control list|network filesystem)/i,
    );
  });

  it('the module comments carry the same scope, so source and policy cannot drift', () => {
    const fsSafe = flat(FS_SAFE);
    expect(fsSafe, 'fs-safe.ts declares no permission-model scope').toMatch(
      /PERMISSION-MODEL SCOPE/,
    );
    expect(fsSafe, 'fs-safe.ts does not name the two mechanisms that fall outside it').toMatch(
      /EXTENDED ACL[\s\S]{0,600}NETWORK FILESYSTEM/i,
    );
    expect(fsSafe, 'fs-safe.ts does not say the two cases go undetected').toMatch(
      /NEITHER IS DETECTED HERE/i,
    );
    const launcher = flat(LAUNCHER);
    expect(
      launcher,
      "launcher.ts still states the 0700 home's exclusion without its scope",
    ).toMatch(/claim about the uid-and-mode-bit model/i);
    expect(launcher, 'launcher.ts does not name the two mechanisms').toMatch(
      /EXTENDED ACL[\s\S]{0,400}NETWORK FILESYSTEM/i,
    );
  });
});
