/*
 * pythonExec.ts
 * Licensed under the MIT license.
 * Author: Ahmed Mahran
 *
 * Provides utils for calling python interpreter from node.
 */
import * as ch from 'child_process';
import path from 'path';
import * as rpc from 'vscode-jsonrpc/node';

const logPythonExecOutput: boolean = true;

let rootDirectory: string | undefined;
let interpreter: string[] | undefined;
let cwd: string | undefined;

export interface ExecutionResult {
    status: boolean;
    output: string;
}

export function initPythonExec(_rootDirectory: string, _interpreter: string[], _cwd?: string) {
    rootDirectory = _rootDirectory;
    interpreter = [..._interpreter];
    cwd = _cwd;
}

export function pythonExec(code: string): ExecutionResult {
    if (!interpreter) {
        throw new Error('Python interpreter is not initialized, please restart!');
    }

    if (!rootDirectory) {
        throw new Error('Could not locate python_exec.py, please restart!');
    }

    const pythonExecPath = path.join(rootDirectory, 'python_files', 'python_exec.py');
    const spawnResult = ch.spawnSync(interpreter[0], [...interpreter.slice(1), pythonExecPath], { input: code, cwd });
    // const spawnResult = ch.spawnSync(interpreter[0], [...interpreter.slice(1)], { input: code, cwd });

    if (spawnResult.error) {
        throw spawnResult.error;
    }

    if (spawnResult.status !== 0) {
        console.error(`Python exec returned with error code ${spawnResult.status}`);
    }

    console.error(spawnResult.stderr.toString());
    const output = spawnResult.stdout.toString();
    if (logPythonExecOutput) {
        console.log(`Python exec output: ${output}`);
    }
    return {
        status: spawnResult.status === 0 && spawnResult.error === undefined,
        output,
    };
}

let serverInstance: PythonServer | undefined;

class PythonServer {
    private readonly _disposables: rpc.Disposable[] = [];

    constructor(private _connection: rpc.MessageConnection, private _pythonServer: ch.ChildProcess) {
        this._initialize();
    }

    async execute(code: string): Promise<ExecutionResult | undefined> {
        return await this._executeCode(code);
    }

    executeSilently(code: string): Promise<ExecutionResult | undefined> {
        return this._executeCode(code);
    }

    interrupt(): void {
        // Passing SIGINT to interrupt only would work for Mac and Linux
        if (this._pythonServer.kill('SIGINT')) {
            console.log('Python server interrupted');
        }
    }

    async checkValidCommand(code: string): Promise<boolean> {
        const completeCode: ExecutionResult = await this._connection.sendRequest('check_valid_command', code);
        if (completeCode.output === 'True') {
            return new Promise((resolve) => resolve(true));
        }
        return new Promise((resolve) => resolve(false));
    }

    dispose(): void {
        this._connection.sendNotification('exit');
        this._disposables.forEach((d) => d.dispose());
        this._connection.dispose();
    }

    private _initialize(): void {
        this._disposables.push(
            this._connection.onNotification('log', (message: string) => {
                console.log('Log:', message);
            })
        );
        this._connection.listen();
    }

    private async _executeCode(code: string): Promise<ExecutionResult | undefined> {
        try {
            const result = await this._connection.sendRequest('execute', code);
            return result as ExecutionResult;
        } catch (err) {
            const error = err as Error;
            console.error(`Error getting response from Python server:`, error);
        }
        return undefined;
    }
}

export function getPythonServer() {
    if (serverInstance) {
        return serverInstance;
    }
    throw new Error('Python server was not initialized! Please restart!');
}

export function createPythonServer(rootDirectory: string, interpreter: string[], cwd?: string): PythonServer {
    disposePythonServer();

    const serverPath = path.join(rootDirectory, 'python_files', 'python_server.py');

    const pythonServer = ch.spawn(interpreter[0], [...interpreter.slice(1), serverPath], {
        cwd, // Launch with correct workspace directory
    });

    pythonServer.stderr.on('data', (data) => {
        console.error(data.toString());
    });
    pythonServer.on('exit', (code) => {
        console.error(`Python server exited with code ${code}`);
    });
    pythonServer.on('error', (err) => {
        console.error(err);
    });
    const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(pythonServer.stdout),
        new rpc.StreamMessageWriter(pythonServer.stdin)
    );
    serverInstance = new PythonServer(connection, pythonServer);
    return serverInstance;
}

export function disposePythonServer() {
    if (serverInstance) {
        serverInstance.dispose();
    }
}
