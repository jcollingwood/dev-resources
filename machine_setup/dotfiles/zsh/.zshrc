#if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
#  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
#fi

export ZSH="$HOME/.oh-my-zsh"

# Standard plugins can be found in $ZSH/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
plugins=(
	git
	asdf
	vi-mode
)

# load local bin to path - mainly for goose?
export PATH="$HOME/.local/bin:$PATH"


# include(): source if exists
include () {
	[[ -f "$1" ]] && source "$1"
}
source $ZSH/oh-my-zsh.sh
include $HOME/.shell_profiles/.barrel
include $HOME/.shell_profiles/.env

# . ~/.asdf/plugins/java/set-java-home.zsh

# alias for starting kanata with config with custom key mappings
alias kanata="sudo ~/.cargo/bin/kanata -c ~/.config/kanata/config.kbd"

# autocorrect package alias
# only run if thefuck is installed
if command -v thefuck >/dev/null 2>&1; then
	eval $(thefuck --alias fix)
fi

source <(fzf --zsh)

# to switch to starship instead of p10k
eval "$(starship init zsh)"

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
