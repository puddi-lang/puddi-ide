const hello = `// Edit the greeting and press Run
fn greet(name: Str) -> Str {
    "Hello, {name}!"
}

fn main() {
    let names = ["Puddi", "WebAssembly"]

    for name in names {
        print(greet(name))
    }
}
`;

export const examples = {
  workspace: {
    name: 'My workspace',
    description: '',
    files: { 'main.pud': hello },
  },
  hello: {
    name: 'Hello world',
    description: 'Strings and functions',
    files: { 'main.pud': hello },
  },
  collections: {
    name: 'Collections',
    description: 'Lists and closures',
    files: {
      'main.pud': `fn main() {
    let numbers = [1, 2, 3, 4, 5, 6]
    let squares = numbers
        .filter(|n| n % 2 == 0)
        .map(|n| n * n)

    print("Even squares: {squares}")
    print("Sum: {squares.sum()}")
}
`,
    },
  },
  modules: {
    name: 'Modules',
    description: 'A two-file program',
    files: {
      'main.pud': `import greeting

fn main() {
    print(greeting.hello("Puddi"))
}
`,
      'greeting.pud': `pub fn hello(name: Str) -> Str {
    "Hello, {name}!"
}
`,
    },
  },
  browser: {
    name: 'Browser DOM',
    description: 'An interactive preview',
    files: {
      'main.pud': `import std.dom

fn main() {
    let app = dom.query("#app").unwrap_or(dom.body())
    let title = dom.create("h1")
    title.set_text("Puddi in the browser")

    let button = dom.create("button")
    button.set_text("Count 0")
    var count = 0

    button.on("click", |_| {
        count += 1
        button.set_text("Count {count}")
    })

    app.append(title)
    app.append(button)
    print("Preview ready")
}
`,
    },
  },
};
