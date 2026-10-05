# plot-exit

A Quarto revealjs extension that makes plots exit with style. When you advance a fragment, every mark in an SVG plot either falls off the slide under gravity or morphs into a bat and flutters away. Going backward reverses the animation, and you can interrupt it mid-flight in either direction.

## Installing

```bash
quarto add EmilHvitfeldt/quarto-revealjs-plot-exit
```

This installs the extension under `_extensions/plot-exit`.

## Using

Enable the plugin in your document's YAML:

```yaml
format: revealjs
revealjs-plugins:
  - plot-exit
```

Then wrap an SVG plot in a fragment with one of the effect classes. The plot must be rendered as SVG (for R, use `#| dev: svg`).

````markdown
::: {.fragment .gravity-exit}
```{r}
#| dev: svg
library(ggplot2)
ggplot(mpg, aes(displ, hwy, color = class)) + geom_point()
```
:::
````

## Effects

| Class | Effect |
| --- | --- |
| `.gravity-exit` | Marks fall off the slide, sweeping left to right. |
| `.bats-exit` | Each mark morphs into a bat silhouette, then flutters off and fades out. |

## Modifiers

| Modifier | Works with | Effect |
| --- | --- | --- |
| `.random-order` | both | Marks go in a random order instead of a left-to-right sweep. |
| `.trails` | `.gravity-exit` | Leaves fading motion trails behind falling marks. |
| `data-n="5"` | both | Only `n` randomly chosen marks animate; the rest stay put. |

Modifiers combine, for example `{.fragment .gravity-exit .random-order .trails data-n="20"}`.

## Example

See [`index.qmd`](index.qmd) for a deck using every effect and modifier.

## Development

Tests use Playwright against the rendered example deck:

```bash
quarto render index.qmd
npm install
npx playwright install chromium
npm test
```

## License

MIT
