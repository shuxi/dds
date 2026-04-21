if (!_isWindows()) {
    // note that normal program exit returns 0
    assert.eq(0, runProgram('true'));
    assert.neq(0, runProgram('false'));
    // Use a name that is extremely unlikely to exist on PATH. Some environments (e.g. WSL with
    // WindowsApps PATH entries) may return EACCES for certain names; we just need a non-zero
    // return code here.
    assert.neq(0, runProgram('__resmoke_program_does_not_exist__'));

    // verify output visually
    runProgram('echo', 'Hello', 'World.', 'How   are   you?');
    runProgram('bash', '-c', 'echo Hello     World. "How   are   you?"');  // only one space is
                                                                           // printed between Hello
                                                                           // and World

    // numbers can be passed as numbers or strings
    runProgram('sleep', 0.5);
    runProgram('sleep', '0.5');

} else {
    runProgram('cmd', '/c', 'echo hello windows');
}
